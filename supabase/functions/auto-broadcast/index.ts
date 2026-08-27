/**
 * auto-broadcast — Sélection automatique quotidienne du match à diffuser ("Set & Forget")
 *
 * Déclencheur : CRON externe (même mécanisme que fetch-matches / facebook-post),
 * une fois par jour, header Authorization: Bearer {CRON_SECRET}.
 *
 * Logique par utilisateur (user_profiles.auto_broadcast_enabled = true) :
 *   1. Équipe favorite (favorite_team_id) joue aujourd'hui ?
 *      → ce match, priorité absolue.
 *   2. Sinon, parmi les compétitions suivies (user_competitions),
 *      le match du jour de la compétition la plus importante
 *      (COMPETITION_IMPORTANCE, proxy statique faute de vraie mesure
 *      de popularité).
 *   3. Sinon → pause pour la journée, rien n'est activé.
 *
 * Le match retenu est activé dans broadcast_selections — exactement comme
 * une sélection manuelle depuis la Mini App. La diffusion elle-même reste
 * gérée par le pipeline existant (fetch-matches détecte le changement de
 * score → appelle facebook-post) : aucune logique de publication n'est
 * dupliquée ici.
 *
 * Idempotence : auto_broadcast_log a une contrainte UNIQUE(telegram_user_id,
 * run_date) — un utilisateur déjà traité aujourd'hui n'est jamais re-décidé,
 * même si ce cron tourne plusieurs fois dans la journée.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { COMPETITION_IMPORTANCE } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

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
const STATUTS_ELIGIBLES = ['scheduled', 'inprogress'];

function fenetreJourUTC(): { debut: string; fin: string; jour: string } {
  const jour = new Date().toISOString().slice(0, 10);
  return { debut: `${jour}T00:00:00.000Z`, fin: `${jour}T23:59:59.999Z`, jour };
}

/** Parmi une liste de matchs, retient celui de la compétition la plus
 *  importante (COMPETITION_IMPORTANCE), puis le plus proche dans le temps
 *  en cas d'égalité. */
function meilleurMatch(matchs: MatchRow[]): MatchRow | null {
  if (!matchs.length) return null;
  return [...matchs].sort((a, b) => {
    const impA = COMPETITION_IMPORTANCE[a.tournament_id ?? ''] ?? 10;
    const impB = COMPETITION_IMPORTANCE[b.tournament_id ?? ''] ?? 10;
    if (impA !== impB) return impB - impA;
    return new Date(a.match_date).getTime() - new Date(b.match_date).getTime();
  })[0];
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { debut, fin, jour } = fenetreJourUTC();

  const rapport = {
    traites: 0, favoriTeam: 0, competitionSuivie: 0, pause: 0, dejaDecides: 0, erreurs: 0,
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
      // ── Idempotence : déjà décidé aujourd'hui ? ──────────────────────────
      const { data: dejaLog } = await supabase
        .from('auto_broadcast_log')
        .select('id')
        .eq('telegram_user_id', uid)
        .eq('run_date', jour)
        .maybeSingle();
      if (dejaLog) { rapport.dejaDecides++; continue; }

      // ── Doit avoir au moins une Page Facebook active pour être traité ────
      const { count: nbPages } = await supabase
        .from('facebook_connections')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_user_id', uid)
        .eq('is_active', true);
      if (!nbPages) continue;

      rapport.traites++;

      let matchChoisi: MatchRow | null = null;
      let raison: 'favorite_team' | 'followed_competition' | 'no_match' = 'no_match';

      // ── Priorité 1 : l'équipe favorite joue aujourd'hui ──────────────────
      if (user.favorite_team_id) {
        const { data: matchsFavori } = await supabase
          .from('matchs_index')
          .select(MATCH_COLUMNS)
          .gte('match_date', debut)
          .lte('match_date', fin)
          .in('status', STATUTS_ELIGIBLES)
          .or(`home_team_id.eq.${user.favorite_team_id},away_team_id.eq.${user.favorite_team_id}`)
          .order('match_date', { ascending: true })
          .limit(1);

        if (matchsFavori?.length) {
          matchChoisi = matchsFavori[0] as unknown as MatchRow;
          raison = 'favorite_team';
        }
      }

      // ── Priorité 2 : compétitions suivies, match le plus important ──────
      if (!matchChoisi) {
        const { data: competitionsSuivies } = await supabase
          .from('user_competitions')
          .select('competition')
          .eq('telegram_user_id', uid)
          .eq('active', true);

        const tournamentIds = (competitionsSuivies ?? []).map((c) => c.competition);

        if (tournamentIds.length) {
          const { data: matchsCompet } = await supabase
            .from('matchs_index')
            .select(MATCH_COLUMNS)
            .gte('match_date', debut)
            .lte('match_date', fin)
            .in('status', STATUTS_ELIGIBLES)
            .in('tournament_id', tournamentIds);

          matchChoisi = meilleurMatch((matchsCompet ?? []) as unknown as MatchRow[]);
          if (matchChoisi) raison = 'followed_competition';
        }
      }

      // ── Activer la diffusion (si un match a été retenu) ──────────────────
      if (matchChoisi) {
        const { error: errBroadcast } = await supabase.from('broadcast_selections').upsert({
          telegram_user_id: uid,
          match_id:         matchChoisi.match_id,
          competition:      matchChoisi.competition,
          home_team:        matchChoisi.home_team,
          away_team:        matchChoisi.away_team,
          is_active:        true,
          fb_page_ids:      [],
          updated_at:       new Date().toISOString(),
        }, { onConflict: 'telegram_user_id,match_id' });

        if (errBroadcast) throw errBroadcast;

        if (raison === 'favorite_team') rapport.favoriTeam++;
        else rapport.competitionSuivie++;
      } else {
        rapport.pause++;
      }

      // ── Journaliser la décision du jour (idempotence + traçabilité) ─────
      await supabase.from('auto_broadcast_log').upsert({
        telegram_user_id: uid,
        run_date:         jour,
        match_id:         matchChoisi?.match_id ?? null,
        reason:           raison,
        competition:      matchChoisi?.competition ?? null,
        home_team:        matchChoisi?.home_team ?? null,
        away_team:        matchChoisi?.away_team ?? null,
      }, { onConflict: 'telegram_user_id,run_date' });

    } catch (err) {
      rapport.erreurs++;
      console.error('[auto-broadcast] Erreur utilisateur', uid, err);
    }
  }

  return new Response(JSON.stringify({ success: true, date: jour, ...rapport }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
