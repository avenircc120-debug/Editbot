/**
 * TheSportsDB — Source 1 : calendrier des matchs + stats de base + lineups
 *
 * Clé env THESPORTSDB_KEY (fallback '3' = tier gratuit public)
 * Pas de rate limit documenté sur le tier gratuit → quota très permissif (500/j)
 *
 * Endpoints utilisés :
 *   eventsnextleague  → prochains matchs d'une ligue
 *   eventspastleague  → derniers matchs (vérification résultats)
 *   eventsseason      → tous les matchs d'une saison (historique H2H)
 *   lookupeventstats  → stats post-match (tirs cadrés/non cadrés, bloqués…)
 *   lookuplineup      → compositions d'équipes
 */

import { THESPORTSDB } from './config.ts';

function baseUrl(): string {
  return `${THESPORTSDB.BASE_URL}/${THESPORTSDB.KEY}`;
}

async function tsdbGet(endpoint: string, params: Record<string, string> = {}): Promise<any | null> {
  const url = new URL(`${baseUrl()}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      console.warn(`[tsdb] HTTP ${res.status} — ${endpoint}`);
      return null;
    }
    const body = await res.json();
    if (!body || (Object.values(body).every(v => v === null))) return null;
    return body;
  } catch (e) {
    console.warn(`[tsdb] Erreur réseau — ${endpoint}:`, e);
    return null;
  }
}

// ─── Types internes ────────────────────────────────────────────────────────────

export interface TsdbMatch {
  idEvent:        string;
  strEvent:       string;
  strSeason:      string;
  idLeague:       string;
  strLeague:      string;
  strHomeTeam:    string;
  strAwayTeam:    string;
  idHomeTeam:     string;
  idAwayTeam:     string;
  intRound:       string | null;
  intHomeScore:   string | null;
  intAwayScore:   string | null;
  strTimestamp:   string;         // ISO 8601 : "2026-08-22T15:00:00"
  dateEvent:      string;
  strTime:        string;
  strVenue:       string | null;
  strStatus:      string;         // "NS" | "FT" | "HT" | "1H" | "2H" …
  strPostponed:   string;
  idAPIfootball:  string | null;  // ← pont vers api-football (ex: "1545409")
}

// ─── Prochains matchs d'une ligue (≤ 5 en tier gratuit) ─────────────────────

export async function getProchainMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsnextleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Derniers matchs terminés d'une ligue (pour vérifier les résultats) ──────

export async function getDerniersMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventspastleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Tous les matchs d'une saison (historique / H2H) ─────────────────────────
// Saison format : "2024-2025"

export async function getMatchsSaison(tsdbLeagueId: string, saison: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsseason.php', { id: tsdbLeagueId, s: saison });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Stats post-match (tirs cadrés, non-cadrés, bloqués…) ────────────────────

export interface TsdbStat {
  strStat:  string;   // "Shots on Goal" | "Shots off Goal" | "Total Shots" …
  intHome:  string;
  intAway:  string;
}

export async function getStatsMatch(idEvent: string): Promise<TsdbStat[] | null> {
  const data = await tsdbGet('lookupeventstats.php', { id: idEvent });
  const stats = data?.eventstats;
  if (!stats?.length) return null;
  return stats as TsdbStat[];
}

// ─── Compositions d'équipes ────────────────────────────────────────────────────

export interface TsdbLineupPlayer {
  strPlayer:      string;
  strPosition:    string;
  intSquadNumber: string;
  strHome:        'Yes' | 'No';
  strSubstitute:  'Yes' | 'No';
  strTeam:        string;
}

export async function getLineupsMatch(idEvent: string): Promise<TsdbLineupPlayer[] | null> {
  const data = await tsdbGet('lookuplineup.php', { id: idEvent });
  const lineup = data?.lineup;
  if (!lineup?.length) return null;
  return lineup as TsdbLineupPlayer[];
}

// ─── Derniers matchs terminés d'une équipe (pour le modèle statistique) ──────
// Utilisé pour estimer la force offensive/défensive réelle (buts marqués /
// concédés sur les derniers matchs), base du calcul de probabilités Poisson.

export async function getDerniersMatchsEquipe(teamId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventslast.php', { id: teamId });
  return (data?.results ?? []) as TsdbMatch[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Convertit un timestamp ISO TheSportsDB en objet Date */
export function tsdbTimestampToDate(strTimestamp: string, strTime?: string): Date {
  // strTimestamp peut être "2026-08-22T15:00:00" ou juste "2026-08-22"
  const raw = strTimestamp.includes('T')
    ? strTimestamp
    : `${strTimestamp}T${strTime ?? '00:00:00'}`;
  return new Date(raw + 'Z'); // TheSportsDB renvoie en UTC
}

/** Filtre les matchs dans les prochains jours (14 par défaut, relevé de 7 pour donner plus de matchs à combiner) */
export function filtrerProchains(matchs: TsdbMatch[], joursMax = 14): TsdbMatch[] {
  const now    = Date.now();
  const limite = now + joursMax * 24 * 3600 * 1000;
  return matchs.filter(ev => {
    const ts = tsdbTimestampToDate(ev.strTimestamp).getTime();
    return ts > now && ts < limite;
  });
}
