/**
 * fetch-matches — Auto-suffisant (tout inliné, pas d'imports relatifs)
 * Ingestion dynamique de tous les marchés SofaScore avec protection de quota.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAPIDAPI_KEY  = Deno.env.get('RAPIDAPI_KEY') ?? '';
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Config ───────────────────────────────────────────────────────────────────
const SOFASCORE_BASE = 'https://sofascore.p.rapidapi.com';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const REFRESH_HOURS  = 12;   // données fraîches 12h
const MAX_EQUIPES    = 5;    // équipes max par tournoi
const MAX_MATCHS     = 2;    // matchs max par équipe

const TOURNAMENT_SEEDS = [
  { id: '17', name: 'Ligue 1',          seasonId: '61737' },
  { id: '7',  name: 'Champions League', seasonId: '61644' },
  { id: '8',  name: 'Premier League',   seasonId: '61627' },
];

const MARKET_ENDPOINTS = [
  { slug: 'statistiques',      endpoint: 'matches/get-statistics'   },
  { slug: 'lineups',           endpoint: 'matches/get-lineups'       },
  { slug: 'incidents',         endpoint: 'matches/get-incidents'     },
  { slug: 'meilleurs_joueurs', endpoint: 'matches/get-best-players'  },
  { slug: 'graphe',            endpoint: 'matches/get-graph'         },
  { slug: 'shotmap',           endpoint: 'matches/get-shotmap'       },
  { slug: 'odds',              endpoint: 'odds/get-by-match'         },
];

// ─── Quota ────────────────────────────────────────────────────────────────────
async function consommerQuota(api: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) { console.warn('[quota] erreur:', error.message); return true; }
  if (!data) console.warn(`[quota] 🛑 ${api} épuisé`);
  return Boolean(data);
}

// ─── SofaScore API ────────────────────────────────────────────────────────────
const API_HEADERS = { 'x-rapidapi-host': SOFASCORE_HOST, 'x-rapidapi-key': RAPIDAPI_KEY };

async function apiGet(endpoint: string, params: Record<string, string>): Promise<any | null> {
  const url = new URL(`${SOFASCORE_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: API_HEADERS });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`SofaScore ${res.status} — ${endpoint}`);
  const body = await res.json();
  if (!body || body.error || Object.keys(body).length === 0) return null;
  return body;
}

async function getStandings(tournamentId: string, seasonId: string) {
  if (!await consommerQuota('rapidapi')) return null;
  return apiGet('tournaments/get-standings', { id: tournamentId, seasonId });
}

async function getNearEvents(teamId: string) {
  if (!await consommerQuota('rapidapi')) return null;
  return apiGet('teams/get-near-events', { id: teamId, page: '0' });
}

async function fetchAllMarkets(
  matchId: string, customId?: string,
  homeTeamId?: string, awayTeamId?: string,
  tournamentId?: string, seasonId?: string,
): Promise<Array<{ slug: string; donnees: any }> | null> {
  if (!await consommerQuota('rapidapi')) return null;

  const calls: Array<{ slug: string; fn: () => Promise<any> }> = [
    ...MARKET_ENDPOINTS.map(({ slug, endpoint }) => ({
      slug, fn: () => apiGet(endpoint, { id: matchId }),
    })),
    ...(customId ? [{ slug: 'h2h', fn: () => apiGet('matches/get-h2h-events', { customId }) }] : []),
    ...(homeTeamId && tournamentId && seasonId ? [{
      slug: 'stats_domicile',
      fn: () => apiGet('teams/get-statistics', { id: homeTeamId, tournamentId, seasonId }),
    }] : []),
    ...(awayTeamId && tournamentId && seasonId ? [{
      slug: 'stats_exterieur',
      fn: () => apiGet('teams/get-statistics', { id: awayTeamId, tournamentId, seasonId }),
    }] : []),
  ];

  const settled = await Promise.allSettled(calls.map(c => c.fn()));
  return settled
    .map((r, i) => r.status === 'fulfilled' && r.value ? { slug: calls[i].slug, donnees: r.value } : null)
    .filter(Boolean) as Array<{ slug: string; donnees: any }>;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function buildCustomId(a?: string, b?: string) { return a && b ? `${a}-${b}` : undefined; }

async function indexMatch(ev: any, competition: string, tournamentId: string, seasonId: string) {
  const matchId = String(ev.id);
  const homeSlug = ev.homeTeam?.slug ?? '';
  const awaySlug = ev.awayTeam?.slug ?? '';
  const status = ev.status?.type === 'finished' ? 'finished'
               : ev.status?.type === 'inprogress' ? 'inprogress' : 'scheduled';

  await supabase.from('matchs_index').upsert({
    match_id: matchId,
    home_team: ev.homeTeam?.name ?? '',
    away_team: ev.awayTeam?.name ?? '',
    home_team_id: String(ev.homeTeam?.id ?? ''),
    away_team_id: String(ev.awayTeam?.id ?? ''),
    home_slug: homeSlug, away_slug: awaySlug,
    competition, tournament_id: tournamentId, season_id: seasonId,
    match_date: new Date((ev.startTimestamp ?? 0) * 1000).toISOString(),
    status,
    home_score: ev.homeScore?.current ?? null,
    away_score: ev.awayScore?.current ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'match_id' });

  return { matchId, homeTeamId: String(ev.homeTeam?.id ?? ''), awayTeamId: String(ev.awayTeam?.id ?? ''), customId: buildCustomId(homeSlug, awaySlug), status };
}

async function getMarchesFrais(matchId: string): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - REFRESH_HOURS * 3600 * 1000).toISOString();
  const { data } = await supabase.from('marches_bruts').select('marche_slug').eq('match_id', matchId).gte('fetched_at', cutoff);
  return new Set((data ?? []).map((r: any) => r.marche_slug));
}

async function stockerMarches(matchId: string, marches: Array<{ slug: string; donnees: any }>) {
  let n = 0;
  for (const { slug, donnees } of marches) {
    const { error } = await supabase.from('marches_bruts').upsert(
      { match_id: matchId, marche_slug: slug, donnees, source: 'sofascore', fetched_at: new Date().toISOString() },
      { onConflict: 'match_id,marche_slug' },
    );
    if (!error) n++;
  }
  return n;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stats = { matchs: 0, marches: 0, skips: 0 };
  let quotaEpuise = false;

  outer:
  for (const t of TOURNAMENT_SEEDS) {
    const standings = await getStandings(t.id, t.seasonId);
    if (!standings) { quotaEpuise = true; break; }

    const rows = (standings?.standings?.[0]?.rows ?? []).slice(0, MAX_EQUIPES);
    for (const row of rows) {
      const teamId = String(row.team?.id ?? '');
      if (!teamId) continue;

      const data = await getNearEvents(teamId);
      if (!data) { quotaEpuise = true; break outer; }

      const events = (data?.events ?? []).slice(0, MAX_MATCHS);
      for (const ev of events) {
        try {
          const { matchId, homeTeamId, awayTeamId, customId } = await indexMatch(ev, t.name, t.id, t.seasonId);
          const frais = await getMarchesFrais(matchId);
          const allSlugs = [...MARKET_ENDPOINTS.map(m => m.slug), 'h2h', 'stats_domicile', 'stats_exterieur'];
          if (allSlugs.every(s => frais.has(s))) { stats.skips++; continue; }

          const marches = await fetchAllMarkets(matchId, customId, homeTeamId, awayTeamId, t.id, t.seasonId);
          if (!marches) { quotaEpuise = true; break outer; }

          const nouveaux = marches.filter(m => !frais.has(m.slug));
          stats.marches += await stockerMarches(matchId, nouveaux);
          stats.matchs++;
        } catch (e) { console.error('match error', ev.id, e); }
      }
    }
  }

  const { data: quotas } = await supabase.from('quota_journalier').select('api,compteur,limite').eq('date', new Date().toISOString().slice(0, 10));

  return new Response(JSON.stringify({
    success: true, ...stats, quota_epuise: quotaEpuise,
    quotas: Object.fromEntries((quotas ?? []).map((q: any) => [q.api, { compteur: q.compteur, limite: q.limite, reste: q.limite - q.compteur }])),
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
