import { CONFIG } from './config.ts';

const RAPIDAPI_KEY = Deno.env.get('RAPIDAPI_KEY') ?? '';
const HEADERS = {
  'x-rapidapi-host': CONFIG.SOFASCORE_HOST,
  'x-rapidapi-key': RAPIDAPI_KEY,
  'Content-Type': 'application/json',
};

async function fetchSofaScore(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${CONFIG.SOFASCORE_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok && res.status !== 204) throw new Error(`SofaScore ${res.status}: ${endpoint}`);
  if (res.status === 204) return null;
  return res.json();
}

// Récupérer les matchs récents + à venir d'une équipe
export async function getTeamNearEvents(teamId: string, page = '0') {
  return fetchSofaScore('teams/get-near-events', { id: teamId, page });
}

// Récupérer les statistiques H2H entre deux équipes
export async function getH2HEvents(customId: string) {
  return fetchSofaScore('matches/get-h2h-events', { customId });
}

// Récupérer les statistiques d'un match
export async function getMatchStatistics(matchId: string) {
  return fetchSofaScore('matches/get-statistics', { id: matchId });
}

// Récupérer les statistiques d'une équipe dans une compétition
export async function getTeamStatistics(teamId: string, tournamentId: string, seasonId: string) {
  return fetchSofaScore('teams/get-statistics', { id: teamId, tournamentId, seasonId });
}

// Récupérer les saisons d'une compétition
export async function getTournamentSeasons(tournamentId: string) {
  return fetchSofaScore('tournaments/get-seasons', { id: tournamentId });
}

// Extraire la forme récente d'une équipe depuis ses matchs
export function extractForm(events: any[], teamId: string, limit = 5): string[] {
  if (!events || !Array.isArray(events)) return [];
  return events
    .filter((e: any) => e.status?.type === 'finished')
    .slice(0, limit)
    .map((e: any) => {
      const isHome = e.homeTeam?.id?.toString() === teamId;
      const homeScore = e.homeScore?.current ?? 0;
      const awayScore = e.awayScore?.current ?? 0;
      if (isHome) return homeScore > awayScore ? 'V' : homeScore < awayScore ? 'D' : 'N';
      return awayScore > homeScore ? 'V' : awayScore < homeScore ? 'D' : 'N';
    });
}

// Construire le customId H2H (format SofaScore: "slugHome-slugAway")
export function buildCustomId(homeSlug: string, awaySlug: string): string {
  return `${homeSlug}-${awaySlug}`;
}
