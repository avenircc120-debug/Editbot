/**
 * TheSportsDB — Calendrier des matchs et scores en direct
 *
 * THESPORTSDB_KEY : 123 = gratuit (30 req/min), clé premium pour v2 livescores
 *
 * V1 endpoints (clé dans l'URL) :
 *   eventsday.php        → tous les matchs d'une journée
 *   eventsnextleague.php → prochains matchs d'une ligue
 *   eventspastleague.php → derniers matchs terminés
 *   lookupevent.php      → détails d'un match par ID
 *
 * V2 endpoints (X-API-KEY header, premium uniquement) :
 *   /livescore/soccer    → tous les matchs soccer en direct
 *   /livescore/{idLeague}→ matchs en direct d'une ligue
 */

import { THESPORTSDB } from './config.ts';

// ─── Requêtes internes ────────────────────────────────────────────────────────

function baseUrlV1(): string {
  return `${THESPORTSDB.BASE_URL}/${THESPORTSDB.KEY}`;
}

async function tsdbGet(endpoint: string, params: Record<string, string> = {}): Promise<any | null> {
  const url = new URL(`${baseUrlV1()}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) { console.warn(`[tsdb] HTTP ${res.status} — ${endpoint}`); return null; }
    const body = await res.json();
    if (!body || Object.values(body).every(v => v === null)) return null;
    return body;
  } catch (e) {
    console.warn(`[tsdb] Erreur réseau — ${endpoint}:`, e);
    return null;
  }
}

/** Requête v2 — clé premium en header X-API-KEY */
async function tsdbGetV2(path: string): Promise<any | null> {
  const key = THESPORTSDB.KEY;
  if (!key || key === '123' || key === '3') {
    console.warn('[tsdb v2] Clé premium requise pour les livescores v2 (THESPORTSDB_KEY)');
    return null;
  }
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v2/json/${path}`, {
      headers: { 'Accept': 'application/json', 'X-API-KEY': key },
    });
    if (res.status === 401 || res.status === 403) { console.warn('[tsdb v2] Clé invalide/non-premium'); return null; }
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) { console.warn(`[tsdb v2] HTTP ${res.status} — ${path}`); return null; }
    const body = await res.json();
    if (!body || Object.values(body).every(v => v === null)) return null;
    return body;
  } catch (e) {
    console.warn(`[tsdb v2] Erreur réseau — ${path}:`, e);
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TsdbMatch {
  idEvent:              string;
  strEvent:             string;
  strSeason:            string;
  idLeague:             string;
  strLeague:            string;
  strHomeTeam:          string;
  strAwayTeam:          string;
  idHomeTeam:           string;
  idAwayTeam:           string;
  intRound:             string | null;
  intHomeScore:         string | null;
  intAwayScore:         string | null;
  strTimestamp:         string;
  dateEvent:            string;
  strTime:              string;
  strVenue:             string | null;
  strStatus:            string;   // "NS" | "FT" | "HT" | "1H" | "2H" | "ET" …
  strProgress:          string | null; // minute en direct
  strPostponed:         string;
  idAPIfootball:        string | null;
  strHomeTeamBadge?:    string | null;
  strAwayTeamBadge?:    string | null;
}

// ─── V1 : Tous les matchs d'une journée ──────────────────────────────────────

export async function getMatchsDuJour(dateISO: string, sport = 'Soccer'): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsday.php', { d: dateISO, s: sport });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── V1 : Prochains matchs d'une ligue ───────────────────────────────────────

export async function getProchainMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsnextleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── V1 : Derniers matchs terminés d'une ligue ───────────────────────────────

export async function getDerniersMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventspastleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── V1 : Détails d'un match par ID (lookupevent) ────────────────────────────

export async function getEvenementDetails(idEvent: string): Promise<TsdbMatch | null> {
  const data = await tsdbGet('lookupevent.php', { id: idEvent });
  const ev = data?.events?.[0] ?? null;
  return ev as TsdbMatch | null;
}

// ─── V2 : Scores en direct — tous les matchs soccer (premium) ────────────────

export async function getLivescoresSoccer(): Promise<TsdbMatch[]> {
  const data = await tsdbGetV2('livescore/soccer');
  return (data?.events ?? data?.livescores ?? []) as TsdbMatch[];
}

// ─── V2 : Scores en direct d'une ligue (premium) ─────────────────────────────

export async function getLivescoresLigue(idLeague: string): Promise<TsdbMatch[]> {
  const data = await tsdbGetV2(`livescore/${idLeague}`);
  return (data?.events ?? data?.livescores ?? []) as TsdbMatch[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function tsdbTimestampToDate(strTimestamp: string, strTime?: string): Date {
  const raw = strTimestamp.includes('T')
    ? strTimestamp
    : `${strTimestamp}T${strTime ?? '00:00:00'}`;
  return new Date(raw + 'Z');
}

/** Match actuellement en cours */
export function estEnDirect(strStatus: string): boolean {
  return ['1H', '2H', 'HT', 'ET', 'PEN', 'LIVE'].includes((strStatus ?? '').toUpperCase());
}

/** Match terminé */
export function estTermine(strStatus: string): boolean {
  return ['FT', 'AET', 'ABAN', 'ABD'].includes((strStatus ?? '').toUpperCase());
}

// ─── V1 : Recherche d'équipe par nom (pour choisir une équipe favorite) ──────

export interface TsdbTeam {
  id:    string;
  name:  string;
  badge: string | null;
  sport: string | null;
}

export async function rechercherEquipe(nom: string): Promise<TsdbTeam[]> {
  const data = await tsdbGet('searchteams.php', { t: nom });
  const teams = (data?.teams ?? []) as Array<{
    idTeam: string; strTeam: string; strTeamBadge: string | null; strSport: string | null;
  }>;
  return teams
    .filter(t => (t.strSport ?? '').toLowerCase() === 'soccer' || !t.strSport)
    .map(t => ({ id: t.idTeam, name: t.strTeam, badge: t.strTeamBadge ?? null, sport: t.strSport ?? null }));
}

export function filtrerProchains(matchs: TsdbMatch[], joursMax = 14): TsdbMatch[] {
  const now    = Date.now();
  const limite = now + joursMax * 24 * 3600 * 1000;
  return matchs.filter(ev => {
    try {
      const d = tsdbTimestampToDate(ev.strTimestamp, ev.strTime).getTime();
      return d >= now && d <= limite;
    } catch { return false; }
  });
}
