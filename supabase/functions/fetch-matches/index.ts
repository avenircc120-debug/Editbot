/**
 * fetch-matches v2 — Discovery dynamique des saisons + tournois actifs en été
 * Pipeline: SofaScore → matchs_index + marches_bruts
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAPIDAPI_KEY  = Deno.env.get('RAPIDAPI_KEY') ?? '';
const CRON_SECRET   = Deno.env.get('CRON_SECRET') ?? '';
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOFASCORE_BASE = 'https://sofascore.p.rapidapi.com';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const API_HEADERS    = { 'x-rapidapi-host': SOFASCORE_HOST, 'x-rapidapi-key': RAPIDAPI_KEY };

// Tournois actifs toute l'année — pas de seasonId hardcodé
const TOURNAMENTS = [
  // Compétitions mondiales
  { id: '16',   name: 'Coupe du Monde FIFA' },
  // Amérique du Sud
  { id: '384',  name: 'Copa Libertadores' },
  { id: '480',  name: 'Copa Sudamericana' },
  // Amérique du Nord
  { id: '242',  name: 'MLS' },
  { id: '352',  name: 'Liga MX' },
  // Brésil / Argentine
  { id: '325',  name: 'Brasileirao' },
  { id: '155',  name: 'Argentine Primera' },
  // Europe (saison août-mai — matchs amicaux/qualifs en juillet)
  { id: '17',   name: 'Ligue 1' },
  { id: '8',    name: 'Premier League' },
  { id: '23',   name: 'La Liga' },
  { id: '35',   name: 'Bundesliga' },
  { id: '23160',name: 'Serie A' },
  { id: '7',    name: 'Champions League' },
  { id: '679',  name: 'Europa League' },
  // Asie
  { id: '600',  name: 'J1 League' },
  { id: '610',  name: 'K League' },
];

const MARKET_ENDPOINTS = [
  { slug: 'statistiques',      endpoint: 'matches/get-statistics'  },
  { slug: 'h2h',               endpoint: 'matches/get-h2h-events'  },
  { slug: 'lineups',           endpoint: 'matches/get-lineups'      },
  { slug: 'incidents',         endpoint: 'matches/get-incidents'    },
  { slug: 'odds',              endpoint: 'odds/get-by-match'        },
];

const MAX_MATCHS_PAR_TOURNOI = 3;

// ─── Quota ────────────────────────────────────────────────────────────────────
async function quota(api: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) { console.warn('[quota]', error.message); return true; }
  if (!data)  console.warn(`[quota] 🛑 ${api} épuisé`);
  return Boolean(data);
}

// ─── SofaScore helpers ────────────────────────────────────────────────────────
async function apiGet(endpoint: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${SOFASCORE_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const r = await fetch(url.toString(), { headers: API_HEADERS });
    if (!r.ok || r.status === 204) return null;
    const body = await r.json();
    return (body && !body.error && Object.keys(body).length > 0) ? body : null;
  } catch (e) {
    console.warn('[api]', endpoint, e);
    return null;
  }
}

// Discovery dynamique de la saison courante d'un tournoi
async function getSaisonActuelle(tournamentId: string): Promise<string | null> {
  if (!await quota('rapidapi')) return null;
  const data = await apiGet('tournaments/get-seasons', { id: tournamentId });
  const seasons: any[] = data?.seasons ?? [];
  if (!seasons.length) return null;
  // La première saison est la plus récente
  return String(seasons[0]?.id ?? '');
}

// Matchs programmés dans les 7 prochains jours pour un tournoi/saison
async function getMatchsProgrammes(tournamentId: string, seasonId: string): Promise<any[]> {
  if (!await quota('rapidapi')) return [];
  const data = await apiGet('tournaments/get-scheduled-events', {
    id: tournamentId,
    seasonId,
    page: '0',
  });
  return data?.events ?? [];
}

// ─── Indexer un match dans matchs_index ───────────────────────────────────────
async function indexerMatch(ev: any, competition: string, tournamentId: string, seasonId: string): Promise<string | null> {
  const matchId     = String(ev.id);
  const homeTeamId  = String(ev.homeTeam?.id ?? '');
  const awayTeamId  = String(ev.awayTeam?.id ?? '');
  const matchDate   = ev.startTimestamp
    ? new Date(ev.startTimestamp * 1000).toISOString()
    : null;

  if (!matchDate || !ev.homeTeam?.name || !ev.awayTeam?.name) return null;

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:      matchId,
    home_team:     ev.homeTeam.name,
    away_team:     ev.awayTeam.name,
    home_team_id:  homeTeamId,
    away_team_id:  awayTeamId,
    home_slug:     ev.homeTeam.slug ?? '',
    away_slug:     ev.awayTeam.slug ?? '',
    competition,
    tournament_id: tournamentId,
    season_id:     seasonId,
    match_date:    matchDate,
    status:        ev.status?.type ?? 'scheduled',
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'match_id' });

  if (error) { console.warn('[index]', matchId, error.message); return null; }
  return matchId;
}

// Vérifier quels marchés sont déjà en base pour ce match
async function getMarchesFrais(matchId: string): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('marches_bruts')
    .select('marche_slug')
    .eq('match_id', matchId)
    .gte('fetched_at', cutoff);
  return new Set((data ?? []).map((r: any) => r.marche_slug));
}

// Stocker les marchés dans marches_bruts
async function stockerMarches(matchId: string, marches: Array<{ slug: string; donnees: any }>): Promise<number> {
  if (!marches.length) return 0;
  const rows = marches.map(m => ({
    match_id:    matchId,
    marche_slug: m.slug,
    donnees:     m.donnees,
    source:      'sofascore',
    fetched_at:  new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('marches_bruts')
    .upsert(rows, { onConflict: 'match_id,marche_slug' });
  if (error) console.warn('[store]', error.message);
  return error ? 0 : rows.length;
}

// Récupérer tous les marchés d'un match en parallèle
async function fetchMarches(matchId: string, customId?: string): Promise<Array<{ slug: string; donnees: any }>> {
  if (!await quota('rapidapi')) return [];

  const calls = MARKET_ENDPOINTS.map(({ slug, endpoint }) => ({
    slug,
    fn: () => {
      const params: Record<string, string> = { id: matchId };
      if (slug === 'h2h' && customId) params['customId'] = customId;
      return apiGet(endpoint, params);
    },
  }));

  const results = await Promise.all(calls.map(c => c.fn()));
  return calls
    .map((c, i) => ({ slug: c.slug, donnees: results[i] }))
    .filter(r => r.donnees !== null);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Sécurité CRON
  if (CRON_SECRET && req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stats = { tournois: 0, matchs: 0, marches: 0, skips: 0, erreurs: 0 };
  let quotaEpuise = false;

  for (const t of TOURNAMENTS) {
    if (quotaEpuise) break;

    // Discovery dynamique de la saison courante
    const seasonId = await getSaisonActuelle(t.id);
    if (!seasonId) {
      // Quota épuisé ou aucune saison trouvée
      if ((await supabase.from('quota_journalier')
            .select('compteur,limite')
            .eq('api', 'rapidapi')
            .eq('date', new Date().toISOString().slice(0, 10))
            .single())?.data?.compteur >= 30) {
        quotaEpuise = true;
      }
      continue;
    }

    // Matchs programmés dans les 7 prochains jours
    const events = await getMatchsProgrammes(t.id, seasonId);
    if (!events.length) continue;

    const aVenir = events
      .filter((ev: any) => {
        const ts = ev.startTimestamp * 1000;
        const now = Date.now();
        return ts > now && ts < now + 7 * 24 * 3600 * 1000;
      })
      .slice(0, MAX_MATCHS_PAR_TOURNOI);

    if (!aVenir.length) continue;
    stats.tournois++;

    for (const ev of aVenir) {
      try {
        const matchId = await indexerMatch(ev, t.name, t.id, seasonId);
        if (!matchId) continue;

        const frais = await getMarchesFrais(matchId);
        const allSlugs = MARKET_ENDPOINTS.map(m => m.slug);
        if (allSlugs.every(s => frais.has(s))) { stats.skips++; continue; }

        const marches = await fetchMarches(matchId, ev.customId);
        if (!marches.length) { quotaEpuise = true; break; }

        const nouveaux = marches.filter(m => !frais.has(m.slug));
        const stored = await stockerMarches(matchId, nouveaux);
        stats.marches += stored;
        stats.matchs++;
      } catch (e) {
        console.error('[match]', ev.id, e);
        stats.erreurs++;
      }
    }
  }

  const { data: quotas } = await supabase
    .from('quota_journalier')
    .select('api,compteur,limite')
    .eq('date', new Date().toISOString().slice(0, 10));

  return new Response(JSON.stringify({
    success:      true,
    ...stats,
    quota_epuise: quotaEpuise,
    quotas:       Object.fromEntries((quotas ?? []).map((q: any) => [
      q.api, { compteur: q.compteur, limite: q.limite, reste: q.limite - q.compteur },
    ])),
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
