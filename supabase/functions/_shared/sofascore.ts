import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.ts';
import { avecQuota } from './quota.ts';

const RAPIDAPI_KEY = Deno.env.get('RAPIDAPI_KEY') ?? '';
const BASE = CONFIG.SOFASCORE_BASE_URL;
const HEADERS = {
  'x-rapidapi-host': CONFIG.SOFASCORE_HOST,
  'x-rapidapi-key':  RAPIDAPI_KEY,
};

// Fetch générique — retourne null si 204/404/vide
async function fetchApi(endpoint: string, params: Record<string, string> = {}): Promise<any | null> {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`SofaScore HTTP ${res.status} — ${endpoint}`);
  const body = await res.json();
  if (!body || body.error || Object.keys(body).length === 0) return null;
  return body;
}

// ─── Découverte de matchs ────────────────────────────────────────────────────

export async function getTeamNearEvents(
  teamId: string,
  supabase: SupabaseClient,
  page = '0',
): Promise<any | null> {
  return avecQuota(supabase, 'rapidapi', () =>
    fetchApi('teams/get-near-events', { id: teamId, page }),
  );
}

export async function getTournamentStandings(
  tournamentId: string,
  seasonId: string,
  supabase: SupabaseClient,
): Promise<any | null> {
  return avecQuota(supabase, 'rapidapi', () =>
    fetchApi('tournaments/get-standings', { id: tournamentId, seasonId }),
  );
}

// ─── Catalogue de tous les endpoints de marché disponibles ──────────────────
// Le système tente TOUS ces endpoints pour chaque match.
// Ajouter un endpoint ici suffit pour qu'il soit automatiquement ingéré.
export const MARKET_ENDPOINTS: Array<{ slug: string; endpoint: string }> = [
  { slug: 'statistiques',      endpoint: 'matches/get-statistics'   },
  { slug: 'lineups',           endpoint: 'matches/get-lineups'       },
  { slug: 'incidents',         endpoint: 'matches/get-incidents'     },
  { slug: 'meilleurs_joueurs', endpoint: 'matches/get-best-players'  },
  { slug: 'graphe',            endpoint: 'matches/get-graph'         },
  { slug: 'shotmap',           endpoint: 'matches/get-shotmap'       },
  { slug: 'odds',              endpoint: 'odds/get-by-match'         },
];

// ─── Fetch dynamique de TOUS les marchés — sans quota ───────────────────────
// (usage interne pour les appels déjà comptés)
async function _fetchAllRaw(
  matchId: string,
  customId?: string,
  homeTeamId?: string,
  awayTeamId?: string,
  tournamentId?: string,
  seasonId?: string,
): Promise<Array<{ slug: string; donnees: any }>> {
  const allCalls: Array<{ slug: string; fn: () => Promise<any> }> = [
    ...MARKET_ENDPOINTS.map(({ slug, endpoint }) => ({
      slug,
      fn: () => fetchApi(endpoint, { id: matchId }),
    })),
    ...(customId ? [{
      slug: 'h2h',
      fn:   () => fetchApi('matches/get-h2h-events', { customId: customId! }),
    }] : []),
    ...(homeTeamId && tournamentId && seasonId ? [{
      slug: 'stats_domicile',
      fn:   () => fetchApi('teams/get-statistics', { id: homeTeamId!, tournamentId: tournamentId!, seasonId: seasonId! }),
    }] : []),
    ...(awayTeamId && tournamentId && seasonId ? [{
      slug: 'stats_exterieur',
      fn:   () => fetchApi('teams/get-statistics', { id: awayTeamId!, tournamentId: tournamentId!, seasonId: seasonId! }),
    }] : []),
  ];

  const settled = await Promise.allSettled(allCalls.map(c => c.fn()));
  const results: Array<{ slug: string; donnees: any }> = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value) {
      results.push({ slug: allCalls[i].slug, donnees: result.value });
    } else if (result.status === 'rejected') {
      console.warn(`[sofascore] "${allCalls[i].slug}" échoué:`, result.reason?.message);
    }
  });

  return results;
}

// ─── Fetch avec vérification de quota (1 unité = toutes les données du match)
// Consomme 1 unité RapidAPI pour l'ensemble des endpoints d'un match.
// Retourne null si quota épuisé.
export async function fetchAllMarketsAvecQuota(
  supabase: SupabaseClient,
  matchId: string,
  customId?: string,
  homeTeamId?: string,
  awayTeamId?: string,
  tournamentId?: string,
  seasonId?: string,
): Promise<Array<{ slug: string; donnees: any }> | null> {
  return avecQuota(supabase, 'rapidapi', () =>
    _fetchAllRaw(matchId, customId, homeTeamId, awayTeamId, tournamentId, seasonId),
  );
}

// ─── Utilitaire ─────────────────────────────────────────────────────────────
export function buildCustomId(homeSlug?: string, awaySlug?: string): string | undefined {
  if (!homeSlug || !awaySlug) return undefined;
  return `${homeSlug}-${awaySlug}`;
}
