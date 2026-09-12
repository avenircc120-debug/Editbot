/**
 * auto-broadcast — Diffusion automatique des matchs en direct ("Set & Forget")
 *
 * Déclencheur : CRON toutes les 15 minutes (aligné sur fetch-matches),
 * header Authorization: Bearer {CRON_SECRET}.
 *
 * Logique par utilisateur (user_profiles.auto_broadcast_enabled = true) :
 *   1. Équipe favorite (favorite_team_id) joue aujourd'hui (programmé ou en
 *      direct) ? → ce match est toujours activé, en plus du reste, sans
 *      limite de nombre.
 *   2. Parmi les compétitions suivies (user_competitions), TOUS les matchs
 *      actuellement EN DIRECT (status = 'inprogress') sont candidats — pas
 *      un seul par jour comme avant. S'il y en a plus que
 *      MAX_MATCHS_COMPETITIONS_SIMULTANES en même temps, seuls les plus
 *      importants (COMPETITION_IMPORTANCE) sont retenus pour ce cycle ; les
 *      autres seront repris à un cycle suivant si une place se libère
 *      (match terminé → désactivé par fetch-matches).
 *
 * Le(s) match(s) retenu(s) sont activés dans broadcast_selections —
 * exactement comme une sélection manuelle depuis la Mini App. La diffusion
 * elle-même reste gérée par le pipeline existant (fetch-matches détecte le
 * changement de score → appelle facebook-post) : aucune logique de
 * publication n'est dupliquée ici. La désactivation en fin de match est
 * également déjà gérée par fetch-matches (désactiverMatchsTermines) : cette
 * fonction n'a donc qu'à ACTIVER, jamais à désactiver.
 *
 * Contrairement à l'ancienne version, il n'y a plus de décision "figée"
 * une fois par jour (auto_broadcast_log ne sert plus qu'à la traçabilité,
 * plus à l'idempotence) : chaque cycle réévalue simplement l'état courant,
 * ce qui est sans risque car l'activation d'un match déjà actif est un
 * no-op (upsert sur telegram_user_id+match_id).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { COMPETITION_IMPORTANCE } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

// Nombre max de matchs de compétitions suivies diffusés EN MÊME TEMPS par
// utilisateur (hors équipe favorite, jamais limitée) — évite d'inonder la
// Page Facebook quand plusieurs grosses compétitions suivies jouent au même
// horaire. Ajustable si besoin.
const MAX_MATCHS_COMPETITIONS_SIMULTANES = 3;

interface MatchRow {
  match_id:      string;
  competition:   string | null;
  tournament_id: string | null;
  home_team:     string;
  away_team:     string;
  home_team_id:  string | null;
  away_team_id:  string | null;
  match_date:    string;
  status:        string;
}

const MATCH_COLUMNS =
  'match_id, competition, tournament_id, home_team, away_team, home_team_id, away_team_id, match_date, status';

function fenetreJourUTC(): { debut: string; fin: string; jour: string } {
  const jour = new Date().toISOString().slice(0, 10);
  return { debut: `${jour}T00:00:00.000Z`, fin: `${jour}T23:59:59.999Z`, jour };
}

function importance(m: MatchRow): number {
  return COMPETITION_IMPORTANCE[m.tournament_id ?? ''] ?? 10;
}

/** Trie par importance décroissante puis par horaire (les plus proches d'abord). */
function trierParImportance(matchs: MatchRow[]): MatchRow[] {
  return [...matchs].sort((a, b) => {
    const diff = importance(b) - importance(a);
    if (diff !== 0) return diff;
    return new Date(a.match_date).getTime() - new Date(b.match_date).getTime();
  });
}

async function activerMatch(uid: number, m: MatchRow): Promise<void> {
  const { error } = await supabase.from('broadcast_selections').upsert({
    telegram_user_id: uid,
    match_id:         m.match_id,
    competition:      m.competition,
    home_team:        m.home_team,
    away_team:        m.away_team,
    is_active:        true,
    fb_page_ids:      [],
  }, { onConflict: 'telegram_user_id,match_id' });
  if (error) throw error;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { debut, fin, jour } = fenetreJourUTC();

  const rapport = {
    utilisateursTraites: 0, favoriTeamActives: 0, competitionsMatchsActives: 0, erreurs: 0,
  };

  const { data: utilisateurs, error: errUsers } = await supabase
    .from('user_profiles')
    .select('telegram_user_id, favorite_team_id, favorite_team_name')
    .eq('auto_broadcast_enabled', true);

  if (errUsers) {
    return new Response(JSON.stringify({ error: errUsers.message }), { status: 500 });
  }

  for (const user of utilisateurs ?? []) {
    const uid = Number(user.telegram_user_id);
    try {
      // ── Doit avoir au moins une Page Facebook active pour être traité ────
      const { count: nbPages } = await supabase
        .from('facebook_connections')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_user_id', uid)
        .eq('is_active', true);
      if (!nbPages) continue;

      rapport.utilisateursTraites++;

      let matchFavori: MatchRow | null = null;

      // ── Équipe favorite : programmée ou en direct aujourd'hui, sans limite ──
      if (user.favorite_team_id) {
        const { data: matchsFavori } = await supabase
          .from('matchs_index')
          .select(MATCH_COLUMNS)
          .gte('match_date', debut)
          .lte('match_date', fin)
          .in('status', ['scheduled', 'inprogress'])
          .or(`home_team_id.eq.${user.favorite_team_id},away_team_id.eq.${user.favorite_team_id}`)
          .order('match_date', { ascending: true })
          .limit(1);

        if (matchsFavori?.length) {
          matchFavori = matchsFavori[0] as unknown as MatchRow;
          await activerMatch(uid, matchFavori);
          rapport.favoriTeamActives++;
        }
      }

      // ── Compétitions suivies : TOUS les matchs actuellement en direct ────
      const { data: competitionsSuivies } = await supabase
        .from('user_competitions')
        .select('competition')
        .eq('telegram_user_id', uid)
        .eq('active', true);

      const tournamentIds = (competitionsSuivies ?? []).map((c) => c.competition);
      if (!tournamentIds.length) continue;

      const { data: matchsEnDirect } = await supabase
        .from('matchs_index')
        .select(MATCH_COLUMNS)
        .eq('status', 'inprogress')
        .in('tournament_id', tournamentIds);

      const candidats = ((matchsEnDirect ?? []) as unknown as MatchRow[])
        .filter((m) => m.match_id !== matchFavori?.match_id);
      if (!candidats.length) continue;

      // Combien de matchs de compétitions suivies sont déjà actifs pour cet
      // utilisateur ? On ne compte que des places disponibles pour ce cycle
      // — un match déjà actif garde sa place même s'il sort du top N ici
      // (il sera désactivé par fetch-matches à la fin du match, pas ici).
      const idsEnDirect = candidats.map((m) => m.match_id);
      const { data: dejaActifs } = await supabase
        .from('broadcast_selections')
        .select('match_id')
        .eq('telegram_user_id', uid)
        .eq('is_active', true)
        .in('match_id', idsEnDirect);

      const dejaActifsIds = new Set((dejaActifs ?? []).map((r) => r.match_id));
      for (const id of dejaActifsIds) {
        const m = candidats.find((c) => c.match_id === id);
        if (m) { await activerMatch(uid, m); rapport.competitionsMatchsActives++; }
      }

      const placesRestantes = MAX_MATCHS_COMPETITIONS_SIMULTANES - dejaActifsIds.size;
      if (placesRestantes > 0) {
        const nouveaux = trierParImportance(candidats.filter((m) => !dejaActifsIds.has(m.match_id)))
          .slice(0, placesRestantes);
        for (const m of nouveaux) {
          await activerMatch(uid, m);
          rapport.competitionsMatchsActives++;
        }
      }
    } catch (err) {
      rapport.erreurs++;
      console.error('[auto-broadcast] Erreur utilisateur', uid, err);
    }
  }

  return new Response(JSON.stringify({ success: true, date: jour, ...rapport }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
