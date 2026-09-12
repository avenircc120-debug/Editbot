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
 *      un seul par jour. S'il y en a plus que MAX_MATCHS_COMPETITIONS_SIMULTANES
 *      en même temps, seuls les plus importants (COMPETITION_IMPORTANCE) sont
 *      retenus pour ce cycle ; les autres seront repris à un cycle suivant si
 *      une place se libère (match terminé → désactivé par fetch-matches).
 *
 * Publication Facebook : dès qu'un match est sélectionné pour la PREMIÈRE
 * fois (jamais actif avant ce cycle), un post est publié tout de suite —
 * pas seulement au coup d'envoi :
 *   - Si le match n'a pas encore commencé : annonce (date, heure) + classement
 *     actuel de la compétition (formatAnnonceFacebook + formatStandingsBlock).
 *   - Si le match est déjà en direct au moment de la sélection : score en
 *     direct (buildFacebookPost), comme pour une sélection manuelle tardive.
 * Ce même post est ensuite mis à jour EN PLACE par facebook-post (fetch-matches
 * détecte kickoff/but/mi-temps/fin → appelle facebook-post → editerPost) grâce
 * au fb_post_id enregistré ici dans facebook_posts_log : un seul post par
 * match, qui évolue de "annonce + classement" à "score en direct".
 *
 * Marche identiquement pour les utilisateurs du bot Telegram et ceux du
 * portail web autonome (portal.html, connexion Facebook sans Telegram) :
 * les deux partagent les mêmes tables (user_profiles, facebook_connections,
 * etc.), aucune logique ici n'est spécifique à Telegram.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { COMPETITION_IMPORTANCE } from '../_shared/config.ts';
import { getEspnStandings } from '../_shared/espn.ts';
import { formatAnnonceFacebook, formatStandingsBlock, buildFacebookPost } from '../_shared/templates.ts';
import { posterSurPage } from '../_shared/facebook.ts';

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

interface FbConnection {
  id:                   number;
  fb_page_id:           string;
  fb_page_name:         string;
  fb_page_access_token: string;
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

/** Marque le match comme diffusé pour cet utilisateur (idempotent). */
async function activerSelection(uid: number, m: MatchRow): Promise<void> {
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

/**
 * Publie le premier post pour un match qui vient d'être sélectionné (jamais
 * actif avant ce cycle) sur toutes les Pages Facebook actives de
 * l'utilisateur, et enregistre le fb_post_id dans facebook_posts_log pour
 * que facebook-post puisse ensuite l'éditer en place au fil du match.
 */
async function annoncerNouveauMatch(m: MatchRow, connexions: FbConnection[]): Promise<void> {
  if (!connexions.length) return;

  let message: string;
  if (m.status === 'inprogress') {
    message = buildFacebookPost({
      competition: m.competition ?? '', homeTeam: m.home_team, awayTeam: m.away_team,
      homeScore: 0, awayScore: 0, status: m.status, eventsLog: '',
    });
  } else {
    const standings = m.tournament_id ? await getEspnStandings(m.tournament_id) : [];
    const standingsBlock = formatStandingsBlock(standings, [m.home_team, m.away_team]);
    message = formatAnnonceFacebook({
      competition: m.competition ?? '', homeTeam: m.home_team, awayTeam: m.away_team,
      matchDate: m.match_date, standingsBlock,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const connexion of connexions) {
    try {
      const result = await posterSurPage(connexion.fb_page_id, connexion.fb_page_access_token, message);
      await supabase.from('facebook_posts_log').upsert({
        connection_id: connexion.id,
        match_id:      m.match_id,
        post_date:     today,
        fb_post_id:    result.postId ?? null,
        status:        result.success ? 'success' : 'error',
        error_message: result.error ?? null,
        events_log:    '',
      }, { onConflict: 'connection_id,match_id,post_date' });
      if (result.success) {
        await supabase.from('facebook_connections').update({ last_post_at: new Date().toISOString() }).eq('id', connexion.id);
      } else {
        console.warn('[auto-broadcast] échec annonce', m.match_id, connexion.fb_page_name, result.error);
      }
    } catch (e) {
      console.error('[auto-broadcast] exception annonce', m.match_id, connexion.fb_page_name, e);
    }
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { debut, fin, jour } = fenetreJourUTC();

  const rapport = {
    utilisateursTraites: 0, favoriTeamActives: 0, competitionsMatchsActives: 0, annoncesPubliees: 0, erreurs: 0,
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
      const { data: connexionsData } = await supabase
        .from('facebook_connections')
        .select('id, fb_page_id, fb_page_name, fb_page_access_token')
        .eq('telegram_user_id', uid)
        .eq('is_active', true);
      const connexions = (connexionsData ?? []) as FbConnection[];
      if (!connexions.length) continue;

      rapport.utilisateursTraites++;

      // ── Rassembler les matchs candidats de ce cycle ──────────────────────
      let matchFavori: MatchRow | null = null;
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
        if (matchsFavori?.length) matchFavori = matchsFavori[0] as unknown as MatchRow;
      }

      const { data: competitionsSuivies } = await supabase
        .from('user_competitions')
        .select('competition')
        .eq('telegram_user_id', uid)
        .eq('active', true);
      const tournamentIds = (competitionsSuivies ?? []).map((c) => c.competition);

      let candidatsCompet: MatchRow[] = [];
      if (tournamentIds.length) {
        const { data: matchsEnDirect } = await supabase
          .from('matchs_index')
          .select(MATCH_COLUMNS)
          .eq('status', 'inprogress')
          .in('tournament_id', tournamentIds);
        candidatsCompet = ((matchsEnDirect ?? []) as unknown as MatchRow[])
          .filter((m) => m.match_id !== matchFavori?.match_id);
      }

      // ── Déterminer, AVANT toute écriture, quels matchs étaient déjà actifs ──
      const idsACandidater = [
        ...(matchFavori ? [matchFavori.match_id] : []),
        ...candidatsCompet.map((m) => m.match_id),
      ];
      const { data: dejaActifsRows } = idsACandidater.length
        ? await supabase.from('broadcast_selections').select('match_id')
            .eq('telegram_user_id', uid).eq('is_active', true).in('match_id', idsACandidater)
        : { data: [] as Array<{ match_id: string }> };
      const dejaActifsIds = new Set((dejaActifsRows ?? []).map((r) => r.match_id));

      // ── Choisir les matchs de compétitions suivies retenus ce cycle ──────
      const dejaActifsCompet = candidatsCompet.filter((m) => dejaActifsIds.has(m.match_id));
      const placesRestantes = MAX_MATCHS_COMPETITIONS_SIMULTANES - dejaActifsCompet.length;
      const nouveauxCompet = placesRestantes > 0
        ? trierParImportance(candidatsCompet.filter((m) => !dejaActifsIds.has(m.match_id))).slice(0, placesRestantes)
        : [];
      const matchsCompetRetenus = [...dejaActifsCompet, ...nouveauxCompet];

      // ── Activer en base, puis annoncer UNIQUEMENT les toutes nouvelles sélections ──
      const toutLesMatchs = [
        ...(matchFavori ? [matchFavori] : []),
        ...matchsCompetRetenus,
      ];
      for (const m of toutLesMatchs) {
        await activerSelection(uid, m);
        if (m === matchFavori) rapport.favoriTeamActives++; else rapport.competitionsMatchsActives++;

        if (!dejaActifsIds.has(m.match_id)) {
          await annoncerNouveauMatch(m, connexions);
          rapport.annoncesPubliees++;
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
