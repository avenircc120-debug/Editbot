/**
 * TheSportsDB — Calendrier des matchs et scores en direct
 *
 * Clé env THESPORTSDB_KEY (fallback '3' = tier gratuit public)
 *
 * Endpoints utilisés :
 *   eventsnextleague  → prochains matchs d'une ligue
 *   eventspastleague  → derniers matchs terminés (résultats)
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TsdbMatch {
  idEvent:             string;
  strEvent:            string;
  strSeason:           string;
  idLeague:            string;
  strLeague:           string;
  strHomeTeam:         string;
  strAwayTeam:         string;
  idHomeTeam:          string;
  idAwayTeam:          string;
  intRound:            string | null;
  intHomeScore:        string | null;
  intAwayScore:        string | null;
  strTimestamp:        string;   // ISO 8601 : "2026-08-22T15:00:00"
  dateEvent:           string;
  strTime:             string;
  strVenue:            string | null;
  strStatus:           string;   // "NS" | "FT" | "HT" | "1H" | "2H" …
  strPostponed:        string;
  idAPIfootball:       string | null;
  strHomeTeamBadge?:   string | null;
  strAwayTeamBadge?:   string | null;
}

// ─── Prochains matchs d'une ligue ─────────────────────────────────────────────

export async function getProchainMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsnextleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Derniers matchs terminés d'une ligue (résultats) ────────────────────────

export async function getDerniersMatchsLigue(tsdbLeagueId: string): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventspastleague.php', { id: tsdbLeagueId });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Tous les matchs (toutes compétitions confondues) d'une journée ──────────
// 1 seul appel API = tous les matchs de la planète pour ce jour-là (peu importe
// la ligue) : c'est ce qui permet de couvrir "toutes les compétitions" sans
// exploser le quota journalier (contrairement à un appel par ligue).

export async function getMatchsDuJour(dateISO: string, sport = 'Soccer'): Promise<TsdbMatch[]> {
  const data = await tsdbGet('eventsday.php', { d: dateISO, s: sport });
  return (data?.events ?? []) as TsdbMatch[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convertit un timestamp ISO TheSportsDB en objet Date (UTC) */
export function tsdbTimestampToDate(strTimestamp: string, strTime?: string): Date {
  const raw = strTimestamp.includes('T')
    ? strTimestamp
    : `${strTimestamp}T${strTime ?? '00:00:00'}`;
  return new Date(raw + 'Z');
}

/** Filtre les matchs dans les prochains N jours (14 par défaut) */
export function filtrerProchains(matchs: TsdbMatch[], joursMax = 14): TsdbMatch[] {
  const now    = Date.now();
  const limite = now + joursMax * 24 * 3600 * 1000;
  return matchs.filter(ev => {
    const ts = tsdbTimestampToDate(ev.strTimestamp).getTime();
    return ts > now && ts < limite;
  });
}

    // ─── Détails complets d'un match : buteurs et minute (lookupevent) ───────────
    export async function getEvenementDetails(eventId: string): Promise<{
    homeGoalDetails: string | null; awayGoalDetails: string | null; minute: number | null;
    } | null> {
    const data = await tsdbGet('lookupevent.php', { id: eventId });
    const ev   = data?.events?.[0];
    if (!ev) return null;
    return {
      homeGoalDetails: (ev.strHomeGoalDetails as string | null) ?? null,
      awayGoalDetails: (ev.strAwayGoalDetails as string | null) ?? null,
      minute:          ev.intMinute != null ? Number(ev.intMinute) : null,
    };
    }
    