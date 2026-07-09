/**
 * api-football.com — Source 2 : stats détaillées
 * (possession %, tirs, cartons, corners, hors-jeu…)
 *
 * Plan gratuit RapidAPI : 100 req/jour
 * On cible 80 max/jour (marge de sécurité gérée par quota_journalier)
 *
 * Host RapidAPI : api-football-v1.p.rapidapi.com
 * Clé env      : RAPIDAPI_KEY (la même clé RapidAPI que précédemment)
 *
 * Endpoints utilisés :
 *   /fixtures/statistics  → stats détaillées post-match ou pré-match enrichies
 *   /fixtures/headtohead  → historique H2H entre deux équipes
 */

import { APIFOOTBALL } from './config.ts';

const RAPIDAPI_KEY = Deno.env.get('RAPIDAPI_KEY') ?? '';

function apifHeaders(): HeadersInit {
  return {
    'x-rapidapi-host': APIFOOTBALL.HOST,
    'x-rapidapi-key':  RAPIDAPI_KEY,
    'Accept':          'application/json',
  };
}

async function apifGet(path: string, params: Record<string, string> = {}): Promise<any | null> {
  const url = new URL(`${APIFOOTBALL.BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), { headers: apifHeaders() });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[apif] HTTP ${res.status} — ${path}`);
      return null;
    }
    const body = await res.json();
    // api-football retourne toujours { response: [...], errors: [...] }
    if (body?.errors && Object.keys(body.errors).length > 0) {
      console.warn(`[apif] Erreur API — ${path}:`, JSON.stringify(body.errors));
      return null;
    }
    return body;
  } catch (e) {
    console.warn(`[apif] Erreur réseau — ${path}:`, e);
    return null;
  }
}

// ─── Types internes ────────────────────────────────────────────────────────────

export interface ApifStat {
  type:  string;          // "Ball Possession" | "Yellow Cards" | "Corner Kicks" …
  value: string | number | null;
}

export interface ApifTeamStats {
  team:       { id: number; name: string };
  statistics: ApifStat[];
}

// ─── Stats détaillées d'un match ──────────────────────────────────────────────
// fixtureId = idAPIfootball provenant de TheSportsDB

export async function getStatsDetaillees(fixtureId: string): Promise<ApifTeamStats[] | null> {
  const data = await apifGet('/fixtures/statistics', { fixture: fixtureId });
  const response: ApifTeamStats[] = data?.response ?? [];
  if (!response.length) return null;
  return response;
}

// ─── Historique H2H entre deux équipes ───────────────────────────────────────
// Retourne les N derniers matchs entre team1 et team2
// Format h2h : "{team1_apif_id}-{team2_apif_id}"

export async function getH2H(
  team1ApifId: string,
  team2ApifId: string,
  last = 10,
): Promise<any[]> {
  const data = await apifGet('/fixtures/headtohead', {
    h2h:  `${team1ApifId}-${team2ApifId}`,
    last: String(last),
  });
  return data?.response ?? [];
}

// ─── Extraction de stat par nom (normalisation) ───────────────────────────────

export function extraireStat(stats: ApifStat[], type: string): string {
  const found = stats.find(s => s.type.toLowerCase() === type.toLowerCase());
  if (!found || found.value === null || found.value === undefined) return 'N/D';
  return String(found.value);
}

// ─── Résumé formaté pour Groq ─────────────────────────────────────────────────

export function resumerStatsApif(teams: ApifTeamStats[]): string {
  if (!teams.length) return 'Stats détaillées non disponibles';

  const home = teams[0];
  const away = teams[1];

  const stat = (teamStats: ApifStat[], type: string) =>
    extraireStat(teamStats, type);

  const lignes: string[] = [
    `Possession    : ${stat(home.statistics, 'Ball Possession')} / ${stat(away.statistics, 'Ball Possession')}`,
    `Tirs totaux   : ${stat(home.statistics, 'Total Shots')} / ${stat(away.statistics, 'Total Shots')}`,
    `Tirs cadrés   : ${stat(home.statistics, 'Shots on Goal')} / ${stat(away.statistics, 'Shots on Goal')}`,
    `Corners       : ${stat(home.statistics, 'Corner Kicks')} / ${stat(away.statistics, 'Corner Kicks')}`,
    `Cartons jaunes: ${stat(home.statistics, 'Yellow Cards')} / ${stat(away.statistics, 'Yellow Cards')}`,
    `Cartons rouges: ${stat(home.statistics, 'Red Cards')} / ${stat(away.statistics, 'Red Cards')}`,
    `Fautes        : ${stat(home.statistics, 'Fouls')} / ${stat(away.statistics, 'Fouls')}`,
    `Hors-jeu      : ${stat(home.statistics, 'Offsides')} / ${stat(away.statistics, 'Offsides')}`,
  ];

  return `Stats détaillées (${home.team.name} / ${away.team.name}) :\n` + lignes.join('\n');
}
