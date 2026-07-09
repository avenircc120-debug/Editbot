import { CONFIG } from './config.ts';

const RAPIDAPI_KEY = Deno.env.get('RAPIDAPI_KEY') ?? '';
const BASE = CONFIG.SOFASCORE_BASE_URL;
const HEADERS = {
  'x-rapidapi-host': CONFIG.SOFASCORE_HOST,
  'x-rapidapi-key': RAPIDAPI_KEY,
  'Content-Type': 'application/json',
};

// Fetch générique — retourne null si 204/404, lève si erreur réseau
async function fetchApi(endpoint: string, params: Record<string, string> = {}): Promise<any | null> {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`SofaScore HTTP ${res.status} on ${endpoint}`);
  const body = await res.json();
  // Retourner null si la réponse est vide ou contient une erreur
  if (!body || body.error || (typeof body === 'object' && Object.keys(body).length === 0)) return null;
  return body;
}

// ─── Découverte de matchs ────────────────────────────────────────────────────

export async function getTeamNearEvents(teamId: string, page = '0') {
  return fetchApi('teams/get-near-events', { id: teamId, page });
}

export async function getTournamentSeasons(tournamentId: string) {
  return fetchApi('tournaments/get-seasons', { id: tournamentId });
}

export async function getTournamentStandings(tournamentId: string, seasonId: string) {
  return fetchApi('tournaments/get-standings', { id: tournamentId, seasonId });
}

// ─── Marchés disponibles pour un match ──────────────────────────────────────
// Liste exhaustive de tous les endpoints testés et disponibles sur cette API.
// Le système essaie chacun et stocke uniquement ceux qui retournent des données.

export const MARKET_ENDPOINTS: Array<{ slug: string; endpoint: string; paramKey: string }> = [
  { slug: 'statistiques',   endpoint: 'matches/get-statistics',   paramKey: 'id'       },
  { slug: 'lineups',        endpoint: 'matches/get-lineups',       paramKey: 'id'       },
  { slug: 'incidents',      endpoint: 'matches/get-incidents',     paramKey: 'id'       },
  { slug: 'meilleurs_joueurs', endpoint: 'matches/get-best-players', paramKey: 'id'    },
  { slug: 'graphe',         endpoint: 'matches/get-graph',         paramKey: 'id'       },
  { slug: 'shotmap',        endpoint: 'matches/get-shotmap',       paramKey: 'id'       },
  { slug: 'odds',           endpoint: 'odds/get-by-match',         paramKey: 'id'       },
];

export const H2H_ENDPOINT = { slug: 'h2h', endpoint: 'matches/get-h2h-events', paramKey: 'customId' };
export const TEAM_STATS_ENDPOINT = { slug: 'stats_equipe', endpoint: 'teams/get-statistics' };

// Récupère dynamiquement tous les marchés disponibles pour un match
export async function fetchAllMarkets(
  matchId: string,
  customId?: string,
  homeTeamId?: string,
  awayTeamId?: string,
  tournamentId?: string,
  seasonId?: string,
): Promise<Array<{ slug: string; donnees: any }>> {
  const results: Array<{ slug: string; donnees: any }> = [];

  // Appels parallèles pour tous les endpoints par ID de match
  const marketPromises = MARKET_ENDPOINTS.map(async ({ slug, endpoint }) => {
    try {
      const data = await fetchApi(endpoint, { id: matchId });
      if (data) results.push({ slug, donnees: data });
    } catch { /* endpoint non dispo → on continue */ }
  });

  await Promise.allSettled(marketPromises);

  // H2H via customId (slugs des équipes)
  if (customId) {
    try {
      const h2h = await fetchApi(H2H_ENDPOINT.endpoint, { customId });
      if (h2h) results.push({ slug: H2H_ENDPOINT.slug, donnees: h2h });
    } catch { /* ignoré */ }
  }

  // Stats équipes (domicile + extérieur)
  if (homeTeamId && tournamentId && seasonId) {
    try {
      const statsHome = await fetchApi(TEAM_STATS_ENDPOINT.endpoint, {
        id: homeTeamId, tournamentId, seasonId,
      });
      if (statsHome) results.push({ slug: 'stats_domicile', donnees: statsHome });
    } catch { /* ignoré */ }
  }

  if (awayTeamId && tournamentId && seasonId) {
    try {
      const statsAway = await fetchApi(TEAM_STATS_ENDPOINT.endpoint, {
        id: awayTeamId, tournamentId, seasonId,
      });
      if (statsAway) results.push({ slug: 'stats_exterieur', donnees: statsAway });
    } catch { /* ignoré */ }
  }

  return results;
}

// Utilitaire: construire le customId H2H depuis les slugs SofaScore
export function buildCustomId(homeSlug?: string, awaySlug?: string): string | undefined {
  if (!homeSlug || !awaySlug) return undefined;
  return `${homeSlug}-${awaySlug}`;
}

// Extraire la forme récente depuis les événements d'une équipe
export function extractForm(events: any[], teamId: string, limit = 5): string[] {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e: any) => e?.status?.type === 'finished')
    .slice(0, limit)
    .map((e: any) => {
      const isHome = String(e.homeTeam?.id) === String(teamId);
      const hs = e.homeScore?.current ?? 0;
      const as_ = e.awayScore?.current ?? 0;
      return isHome
        ? (hs > as_ ? 'V' : hs < as_ ? 'D' : 'N')
        : (as_ > hs ? 'V' : as_ < hs ? 'D' : 'N');
    });
}
