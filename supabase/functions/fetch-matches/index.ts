/**
 * fetch-matches v4 — Pipeline dual-source : TheSportsDB + SofaScore
 *
 * Phase 1 — TheSportsDB → Calendrier
 *   Récupère les prochains matchs par ligue et les indexe dans matchs_index.
 *   Stocke l'événement brut TheSportsDB (slug: 'tsdb_event').
 *
 * Phase 2 — TheSportsDB → Enrichissement de base
 *   Stats de base + lineups si disponibles (slugs: 'tsdb_stats', 'lineups').
 *
 * Phase 3 — SofaScore (RapidAPI) → H2H
 *   Pour chaque date unique des matchs à venir, 1 requête SofaScore pour
 *   récupérer tous les événements du jour, puis 1 requête H2H par match trouvé.
 *   Budget : 15 req/jour (quota sofascore).
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES }                                  from '../_shared/config.ts';
import { consommerQuota, consommerQuotaStrict, lireQuotas } from '../_shared/quota.ts';
import {
  getProchainMatchsLigue,
  getStatsMatch,
  getLineupsMatch,
  filtrerProchains,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';
import {
  getEventsByDate,
  getH2HEvents,
  trouverEventSofascore,
} from '../_shared/sofascore.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_MATCHS_PAR_LIGUE = 5;   // Limite TheSportsDB tier gratuit
const MAX_H2H_PAR_RUN      = 10;  // Budget SofaScore H2H (15 req/j partagés avec events/date)

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
    ligues: 0, matchs: 0, tsdb_stats: 0, lineups: 0,
    sofascore_dates: 0, h2h: 0, skips: 0, erreurs: 0,
  };

  // Stocke les matchs indexés pour la phase 3
  const matchsIndexes: Array<{ matchId: string; homeTeam: string; awayTeam: string; matchDate: string }> = [];

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
          homeTeam:  ev.strHomeTeam,
          awayTeam:  ev.strAwayTeam,
          matchDate: tsdbTimestampToDate(ev.strTimestamp).toISOString(),
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
  // PHASE 3 — SofaScore → H2H pour chaque match
  // Stratégie économe : 1 req SofaScore par date unique pour tous les matchs
  // du jour, puis 1 req H2H par match trouvé (dans la limite du budget).
  // ════════════════════════════════════════════════════════════════════════════

  // Grouper les matchs par date (YYYY-MM-DD)
  const parDate: Record<string, typeof matchsIndexes> = {};
  for (const m of matchsIndexes) {
    const dateKey = m.matchDate.slice(0, 10);
    if (!parDate[dateKey]) parDate[dateKey] = [];
    parDate[dateKey].push(m);
  }

  let h2hCount = 0;

  for (const [dateKey, matchsDuJour] of Object.entries(parDate)) {
    if (h2hCount >= MAX_H2H_PAR_RUN) break;

    // 1 requête SofaScore pour récupérer tous les matchs du jour
    const sfOk = await consommerQuotaStrict(supabase, 'sofascore');
    if (!sfOk) { console.warn('[sofascore] Quota épuisé (events/date)'); break; }

    let eventsJour: Awaited<ReturnType<typeof getEventsByDate>> = [];
    try {
      eventsJour = await getEventsByDate(dateKey);
      stats.sofascore_dates++;
    } catch (e) {
      console.error('[phase3] events/date', dateKey, e);
      stats.erreurs++;
      continue;
    }

    // Pour chaque match du jour, trouver son équivalent SofaScore puis fetch H2H
    for (const match of matchsDuJour) {
      if (h2hCount >= MAX_H2H_PAR_RUN) break;
      if (await dejaFrais(match.matchId, 'h2h', 48)) { stats.skips++; continue; }

      const sfEvent = trouverEventSofascore(eventsJour, match.homeTeam, match.awayTeam);
      if (!sfEvent) { stats.skips++; continue; }

      // 1 requête H2H
      const h2hOk = await consommerQuotaStrict(supabase, 'sofascore');
      if (!h2hOk) { console.warn('[sofascore] Quota épuisé (h2h)'); break; }

      h2hCount++;

      try {
        const h2hEvents = await getH2HEvents(sfEvent.id);
        if (h2hEvents.length) {
          await stockerMarche(match.matchId, 'h2h', { events: h2hEvents }, 'sofascore');
          stats.h2h++;
        }
      } catch (e) {
        console.error('[phase3] h2h', match.matchId, e);
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
