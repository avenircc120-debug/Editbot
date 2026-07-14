/**
 * fetch-matches — Ingestion des scores en direct (TheSportsDB)
 *
 * Récupère le calendrier + les scores des prochains matchs pour chaque
 * compétition suivie et les indexe dans matchs_index (source de vérité
 * des scores en direct, conservée intégralement).
 *
 * Dès qu'un score/statut change sur un match, déclenche immédiatement
 * facebook-post pour diffuser ce match aux Pages Facebook concernées.
 *
 * Fix : appelle aussi eventspastleague pour mettre à jour les matchs
 * déjà commencés (live) ou terminés — filtrerProchains (ts > now)
 * les excluait complètement.
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES } from '../_shared/config.ts';
import { consommerQuota, lireQuotas } from '../_shared/quota.ts';
import {
  getProchainMatchsLigue,
  getDerniersMatchsLigue,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_MATCHS_PAR_LIGUE = 15;

function normaliserStatus(strStatus: string | undefined): string {
  switch ((strStatus ?? '').toUpperCase()) {
    case 'FT': case 'AET': case 'PEN': return 'finished';
    case 'HT': case '1H': case '2H': case 'ET': return 'inprogress';
    case 'PST': case 'CANC': case 'ABD': return 'postponed';
    default: return 'scheduled';
  }
}

async function indexerMatch(ev: TsdbMatch, competition: string): Promise<{ matchId: string; changed: boolean; row: any } | null> {
  if (!ev.strHomeTeam || !ev.strAwayTeam) return null;
  const matchDate = tsdbTimestampToDate(ev.strTimestamp).toISOString();
  const status    = normaliserStatus(ev.strStatus);
  const homeScore = ev.intHomeScore !== null && ev.intHomeScore !== undefined ? Number(ev.intHomeScore) : null;
  const awayScore = ev.intAwayScore !== null && ev.intAwayScore !== undefined ? Number(ev.intAwayScore) : null;

  const { data: avant } = await supabase
    .from('matchs_index')
    .select('status, home_score, away_score')
    .eq('match_id', ev.idEvent)
    .maybeSingle();

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:        ev.idEvent,
    home_team:       ev.strHomeTeam,
    away_team:       ev.strAwayTeam,
    home_team_id:    ev.idHomeTeam ?? null,
    away_team_id:    ev.idAwayTeam ?? null,
    competition,
    tournament_id:   ev.idLeague ?? null,
    season_id:       ev.strSeason ?? null,
    match_date:      matchDate,
    status,
    home_score:      homeScore,
    away_score:      awayScore,
    id_thesportsdb:  ev.idEvent,
    home_team_badge: ev.strHomeTeamBadge ?? null,
    away_team_badge: ev.strAwayTeamBadge ?? null,
    updated_at:      new Date().toISOString(),
  }, { onConflict: 'match_id' });

  if (error) {
    console.warn('[index]', ev.idEvent, error.message);
    return null;
  }

  const changed = !avant
    || avant.status    !== status
    || avant.home_score !== homeScore
    || avant.away_score !== awayScore;

  const enDirectOuTermine = status === 'inprogress' || status === 'finished';

  return {
    matchId: ev.idEvent,
    changed:  changed && enDirectOuTermine && homeScore !== null && awayScore !== null,
    row: { matchId: ev.idEvent, competition, homeTeam: ev.strHomeTeam, awayTeam: ev.strAwayTeam, homeScore, awayScore, status },
  };
}

async function diffuserSurFacebook(matches: any[]) {
  if (!matches.length) return;
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/facebook-post`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ matches }),
    });
  } catch (e) {
    console.error('[fetch-matches] Erreur appel facebook-post:', e);
  }
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const stats = { indexes: 0, erreurs: 0, diffuses: 0 };
  const matchsAModifier: any[] = [];
  const now = Date.now();

  for (const ligue of LEAGUES) {
    // 1er quota : eventsnextleague
    const okNext = await consommerQuota(supabase, 'thesportsdb');
    if (!okNext) { console.warn('[fetch-matches] Quota thesportsdb épuisé'); break; }

    try {
      // ── Prochains matchs (inclut les matchs live dont l'heure de début est passée récemment)
      const prochains = await getProchainMatchsLigue(ligue.tsdb_id);

      // Fenêtre : matchs démarrés il y a moins de 3h → jusqu'à +14j
      const filtresNext = (prochains ?? []).filter(ev => {
        const ts = tsdbTimestampToDate(ev.strTimestamp).getTime();
        return ts > now - 3 * 3600 * 1000 && ts < now + 14 * 24 * 3600 * 1000;
      });

      // 2e quota : eventspastleague pour les matchs terminés récents
      const okPast = await consommerQuota(supabase, 'thesportsdb');
      const derniers = okPast ? await getDerniersMatchsLigue(ligue.tsdb_id) : [];

      // Fenêtre : derniers 5 jours, sans doublons avec filtresNext
      const nextIds = new Set(filtresNext.map(e => e.idEvent));
      const filtresPast = (derniers ?? []).filter(ev => {
        const ts = tsdbTimestampToDate(ev.strTimestamp).getTime();
        return ts > now - 5 * 24 * 3600 * 1000 && !nextIds.has(ev.idEvent);
      });

      const tous = [...filtresNext, ...filtresPast].slice(0, MAX_MATCHS_PAR_LIGUE);

      for (const ev of tous) {
        const res = await indexerMatch(ev, ligue.name);
        if (!res) { stats.erreurs++; continue; }
        stats.indexes++;
        if (res.changed) matchsAModifier.push(res.row);
      }
    } catch (e) {
      console.error('[fetch-matches]', ligue.name, e);
      stats.erreurs++;
    }
  }

  await diffuserSurFacebook(matchsAModifier);
  stats.diffuses = matchsAModifier.length;

  const quotas = await lireQuotas(supabase);

  return new Response(
    JSON.stringify({ success: true, ...stats, quotas, timestamp: new Date().toISOString() }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
