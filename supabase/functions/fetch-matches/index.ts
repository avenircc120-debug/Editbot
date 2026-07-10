/**
 * fetch-matches v5 — Pipeline TheSportsDB (SofaScore retiré)
 *
 * Phase 1 — TheSportsDB → Calendrier
 *   Récupère les prochains matchs par ligue et les indexe dans matchs_index.
 *   Stocke l'événement brut TheSportsDB (slug: 'tsdb_event').
 *
 * Phase 2 — TheSportsDB → Enrichissement de base
 *   Stats de base + lineups si disponibles (slugs: 'tsdb_stats', 'lineups').
 *
 * SofaScore (H2H) a été retiré pour éviter tout conflit de cron/quota avec
 * The Odds API (voir fetch-odds), qui utilise désormais le même budget RapidAPI.
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES }                                  from '../_shared/config.ts';
import { consommerQuota, lireQuotas } from '../_shared/quota.ts';
import {
  getProchainMatchsLigue,
  getStatsMatch,
  getLineupsMatch,
  getDerniersMatchsEquipe,
  filtrerProchains,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_MATCHS_PAR_LIGUE = 5;   // Limite TheSportsDB tier gratuit

// ─── Helpers DB ───────────────────────────────────────────────────────────────

async function indexerMatch(ev: TsdbMatch, competition: string): Promise<string | null> {
  const matchDate = tsdbTimestampToDate(ev.strTimestamp).toISOString();
  if (!ev.strHomeTeam || !ev.strAwayTeam) return null;

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:        ev.idEvent,
    home_team:       ev.strHomeTeam,
    away_team:       ev.strAwayTeam,
    home_team_id:    ev.idHomeTeam ?? null,
    away_team_id:    ev.idAwayTeam ?? null,
    home_slug:       null,
    away_slug:       null,
    competition,
    tournament_id:   ev.idLeague ?? null,
    season_id:       ev.strSeason ?? null,
    match_date:      matchDate,
    status:          normaliserStatus(ev.strStatus),
    home_score:      ev.intHomeScore !== null ? Number(ev.intHomeScore) : null,
    away_score:      ev.intAwayScore !== null ? Number(ev.intAwayScore) : null,
    id_thesportsdb:  ev.idEvent,
    updated_at:      new Date().toISOString(),
  }, { onConflict: 'match_id' });

  if (error) {
    console.warn('[index]', ev.idEvent, error.message);
    return null;
  }
  return ev.idEvent;
}

function normaliserStatus(strStatus: string | undefined): string {
  switch ((strStatus ?? '').toUpperCase()) {
    case 'FT': case 'AET': case 'PEN': return 'finished';
    case 'HT': case '1H': case '2H': case 'ET': return 'inprogress';
    case 'PST': case 'CANC': case 'ABD': return 'postponed';
    default: return 'scheduled';
  }
}

async function dejaFrais(matchId: string, slug: string, heures = 12): Promise<boolean> {
  const cutoff = new Date(Date.now() - heures * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('marches_bruts')
    .select('id')
    .eq('match_id', matchId)
    .eq('marche_slug', slug)
    .gte('fetched_at', cutoff)
    .maybeSingle();
  return !!data;
}

async function stockerMarche(matchId: string, slug: string, donnees: any, source: string): Promise<void> {
  const { error } = await supabase.from('marches_bruts').upsert(
    { match_id: matchId, marche_slug: slug, donnees, source, fetched_at: new Date().toISOString() },
    { onConflict: 'match_id,marche_slug' },
  );
  if (error) console.warn(`[marches_bruts] ${matchId}/${slug}:`, error.message);
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stats = {
    ligues: 0, matchs: 0, tsdb_stats: 0, lineups: 0, forme: 0, erreurs: 0,
  };

  const matchsIndexes: Array<{
    matchId: string; homeTeam: string; awayTeam: string; matchDate: string;
    homeTeamId: string | null; awayTeamId: string | null;
  }> = [];

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 1 — TheSportsDB → Calendrier des matchs
  // ════════════════════════════════════════════════════════════════════════════

  for (const league of LEAGUES) {
    const ok = await consommerQuota(supabase, 'thesportsdb');
    if (!ok) break;

    try {
      const matchs = await getProchainMatchsLigue(league.tsdb_id);
      const prochains = filtrerProchains(matchs).slice(0, MAX_MATCHS_PAR_LIGUE);
      stats.ligues++;

      for (const ev of prochains) {
        const matchId = await indexerMatch(ev, league.name);
        if (!matchId) continue;
        stats.matchs++;

        // Stocker l'événement brut TheSportsDB
        if (!await dejaFrais(matchId, 'tsdb_event', 12)) {
          await stockerMarche(matchId, 'tsdb_event', ev, 'thesportsdb');
        }

        matchsIndexes.push({
          matchId,
          homeTeam:   ev.strHomeTeam,
          awayTeam:   ev.strAwayTeam,
          matchDate:  tsdbTimestampToDate(ev.strTimestamp).toISOString(),
          homeTeamId: ev.idHomeTeam ?? null,
          awayTeamId: ev.idAwayTeam ?? null,
        });
      }
    } catch (e) {
      console.error('[phase1]', league.name, e);
      stats.erreurs++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 2 — TheSportsDB → Stats de base + Lineups
  // ════════════════════════════════════════════════════════════════════════════

  for (const { matchId } of matchsIndexes) {
    // Stats de base
    if (!await dejaFrais(matchId, 'tsdb_stats', 24)) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) break;
      try {
        const s = await getStatsMatch(matchId);
        if (s) {
          await stockerMarche(matchId, 'tsdb_stats', { eventstats: s }, 'thesportsdb');
          stats.tsdb_stats++;
        }
      } catch (e) {
        console.error('[phase2-stats]', matchId, e);
        stats.erreurs++;
      }
    }

    // Lineups
    if (!await dejaFrais(matchId, 'lineups', 24)) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) break;
      try {
        const l = await getLineupsMatch(matchId);
        if (l?.length) {
          await stockerMarche(matchId, 'lineups', { lineup: l }, 'thesportsdb');
          stats.lineups++;
        }
      } catch (e) {
        console.error('[phase2-lineups]', matchId, e);
        stats.erreurs++;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3 — TheSportsDB → Forme récente des équipes (buts marqués/concédés)
  // Base du calcul de probabilités Poisson dans analyse-matches.
  // ════════════════════════════════════════════════════════════════════════════

  for (const { matchId, homeTeamId, awayTeamId } of matchsIndexes) {
    if (homeTeamId && !await dejaFrais(matchId, 'forme_domicile', 24)) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) break;
      try {
        const derniers = await getDerniersMatchsEquipe(homeTeamId);
        if (derniers?.length) {
          await stockerMarche(matchId, 'forme_domicile', { equipe_id: homeTeamId, matchs: derniers }, 'thesportsdb');
          stats.forme++;
        }
      } catch (e) {
        console.error('[phase3-forme-dom]', matchId, e);
        stats.erreurs++;
      }
    }

    if (awayTeamId && !await dejaFrais(matchId, 'forme_exterieur', 24)) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) break;
      try {
        const derniers = await getDerniersMatchsEquipe(awayTeamId);
        if (derniers?.length) {
          await stockerMarche(matchId, 'forme_exterieur', { equipe_id: awayTeamId, matchs: derniers }, 'thesportsdb');
          stats.forme++;
        }
      } catch (e) {
        console.error('[phase3-forme-ext]', matchId, e);
        stats.erreurs++;
      }
    }
  }

  // ─── Rapport final ─────────────────────────────────────────────────────────

  const quotas = await lireQuotas(supabase);

  return new Response(JSON.stringify({
    success: true,
    ...stats,
    quotas,
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
