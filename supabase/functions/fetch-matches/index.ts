/**
 * fetch-matches v3 — Pipeline dual-source
 *
 * Phase 1 — TheSportsDB → Calendrier
 *   Récupère les prochains matchs par ligue et les indexe dans matchs_index.
 *   Stocke l'événement brut TheSportsDB dans marches_bruts (slug: 'tsdb_event').
 *
 * Phase 2 — TheSportsDB → Enrichissement de base
 *   Pour chaque match indexé : stats de base + lineups si disponibles.
 *   (marches_bruts slug: 'tsdb_stats', 'lineups')
 *
 * Phase 3 — api-football → Stats détaillées
 *   Pour les matchs disposant d'un idAPIfootball : possession, cartons, corners.
 *   Consomme le quota apifootball (80 req/j max).
 *   (marches_bruts slug: 'apif_stats')
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES }                         from '../_shared/config.ts';
import { consommerQuota, lireQuotas }      from '../_shared/quota.ts';
import {
  getProchainMatchsLigue,
  getStatsMatch,
  getLineupsMatch,
  filtrerProchains,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';
import { getStatsDetaillees }              from '../_shared/apifootball.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_MATCHS_PAR_LIGUE    = 5;   // Limite TheSportsDB tier gratuit
const MAX_MATCHS_APIF_PAR_RUN = 15;  // Budget api-football (80 req/j partagés)

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
    id_apifootball:  ev.idAPIfootball ?? null,
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
    case 'FT':
    case 'AET':
    case 'PEN':
      return 'finished';
    case 'HT':
    case '1H':
    case '2H':
    case 'ET':
      return 'inprogress';
    case 'PST':
    case 'CANC':
    case 'ABD':
      return 'postponed';
    default:
      return 'scheduled'; // NS (Not Started), vide
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
  if (error) console.warn(`[store] ${slug}@${matchId}:`, error.message);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stats = {
    ligues:         0,
    matchs_indexes: 0,
    tsdb_stats:     0,
    lineups:        0,
    apif_stats:     0,
    skips:          0,
    erreurs:        0,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1 — TheSportsDB → Calendrier des prochains matchs
  // ══════════════════════════════════════════════════════════════════════════

  const matchsIndexes: Array<{ matchId: string; idAPIfootball: string | null }> = [];

  for (const ligue of LEAGUES) {
    // Quota TheSportsDB très permissif (500/j) — on consomme 1 unité par ligue
    const ok = await consommerQuota(supabase, 'thesportsdb');
    if (!ok) { console.warn('[tsdb] Quota épuisé (Phase 1)'); break; }

    try {
      const evts = await getProchainMatchsLigue(ligue.tsdb_id);
      const aVenir = filtrerProchains(evts, 7).slice(0, MAX_MATCHS_PAR_LIGUE);

      if (!aVenir.length) continue;
      stats.ligues++;

      for (const ev of aVenir) {
        try {
          // Stocker l'événement brut TheSportsDB
          const matchId = await indexerMatch(ev, ligue.name);
          if (!matchId) continue;

          await stockerMarche(matchId, 'tsdb_event', ev, 'thesportsdb');
          matchsIndexes.push({ matchId, idAPIfootball: ev.idAPIfootball ?? null });
          stats.matchs_indexes++;
        } catch (e) {
          console.error('[phase1] match', ev.idEvent, e);
          stats.erreurs++;
        }
      }
    } catch (e) {
      console.error('[phase1] ligue', ligue.tsdb_id, e);
      stats.erreurs++;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — TheSportsDB → Stats de base + Lineups
  // ══════════════════════════════════════════════════════════════════════════

  for (const { matchId } of matchsIndexes) {
    // Stats de base (tirs)
    if (!await dejaFrais(matchId, 'tsdb_stats')) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) { console.warn('[tsdb] Quota épuisé (Phase 2 stats)'); break; }

      const tsStats = await getStatsMatch(matchId);
      if (tsStats) {
        await stockerMarche(matchId, 'tsdb_stats', { eventstats: tsStats }, 'thesportsdb');
        stats.tsdb_stats++;
      }
    } else {
      stats.skips++;
    }

    // Lineups
    if (!await dejaFrais(matchId, 'lineups')) {
      const ok = await consommerQuota(supabase, 'thesportsdb');
      if (!ok) { console.warn('[tsdb] Quota épuisé (Phase 2 lineups)'); break; }

      const lineup = await getLineupsMatch(matchId);
      if (lineup) {
        await stockerMarche(matchId, 'lineups', { lineup }, 'thesportsdb');
        stats.lineups++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3 — api-football → Stats détaillées (possession, cartons, corners)
  // Uniquement pour les matchs avec idAPIfootball, dans la limite du budget
  // ══════════════════════════════════════════════════════════════════════════

  let apifCount = 0;

  for (const { matchId, idAPIfootball } of matchsIndexes) {
    if (!idAPIfootball || apifCount >= MAX_MATCHS_APIF_PAR_RUN) break;
    if (await dejaFrais(matchId, 'apif_stats', 24)) { stats.skips++; continue; }

    const ok = await consommerQuota(supabase, 'apifootball');
    if (!ok) { console.warn('[apif] Quota épuisé (Phase 3)'); break; }

    try {
      const apifStats = await getStatsDetaillees(idAPIfootball);
      if (apifStats) {
        await stockerMarche(matchId, 'apif_stats', { response: apifStats }, 'apifootball');
        stats.apif_stats++;
        apifCount++;
      }
    } catch (e) {
      console.error('[phase3] apif', matchId, e);
      stats.erreurs++;
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
