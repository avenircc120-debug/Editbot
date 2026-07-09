/**
 * SofaScore — Source d'enrichissement : H2H + events par date
 *
 * Plan gratuit RapidAPI : ~500 req/mois → 15/jour (quota géré dans quota_journalier)
 * Host : sofascore.p.rapidapi.com
 * Clé env : RAPIDAPI_KEY
 *
 * Endpoints utilisés :
 *   /api/v1/sport/football/scheduled-events/{date}  → tous les matchs foot d'une date
 *   /api/v1/event/{eventId}/h2h/events              → historique H2H entre deux équipes
 */

const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const SOFASCORE_BASE = `https://${SOFASCORE_HOST}`;
const RAPIDAPI_KEY   = Deno.env.get('RAPIDAPI_KEY') ?? '';

function sfHeaders(): HeadersInit {
  return {
    'x-rapidapi-host': SOFASCORE_HOST,
    'x-rapidapi-key':  RAPIDAPI_KEY,
    'Accept':          'application/json',
  };
}

async function sfGet(path: string): Promise<any | null> {
  const url = `${SOFASCORE_BASE}${path}`;
  try {
    const res = await fetch(url, { headers: sfHeaders() });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[sofascore] HTTP ${res.status} — ${path}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[sofascore] Erreur réseau — ${path}:`, e);
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SfEvent {
  id:           number;
  slug:         string;
  homeTeam:     { id: number; name: string; slug: string };
  awayTeam:     { id: number; name: string; slug: string };
  homeScore?:   { current?: number; display?: number };
  awayScore?:   { current?: number; display?: number };
  startTimestamp: number;
  status?:      { type: string; description: string };
  tournament?:  { name: string; uniqueTournament?: { id: number } };
}

// ─── Matchs programmés pour une date (format YYYY-MM-DD) ─────────────────────
// Retourne TOUS les matchs football de la journée (toutes compétitions confondues)

export async function getEventsByDate(date: string): Promise<SfEvent[]> {
  const data = await sfGet(`/api/v1/sport/football/scheduled-events/${date}`);
  return (data?.events ?? []) as SfEvent[];
}

// ─── Historique H2H pour un événement SofaScore ───────────────────────────────

export async function getH2HEvents(sofascoreEventId: number): Promise<SfEvent[]> {
  const data = await sfGet(`/api/v1/event/${sofascoreEventId}/h2h/events`);
  // La réponse contient { firstTeamEvents: [...], secondTeamEvents: [...] }
  // On combine les deux listes en un seul historique
  const first:  SfEvent[] = data?.firstTeamEvents  ?? [];
  const second: SfEvent[] = data?.secondTeamEvents ?? [];

  // Fusionner et dédupliquer par id, trier par date décroissante
  const all = [...first, ...second];
  const seen = new Set<number>();
  const uniq: SfEvent[] = [];
  for (const e of all) {
    if (!seen.has(e.id)) { seen.add(e.id); uniq.push(e); }
  }
  uniq.sort((a, b) => b.startTimestamp - a.startTimestamp);
  return uniq.slice(0, 10);
}

// ─── Recherche d'un événement SofaScore par noms d'équipes + date ─────────────
// Compare les noms d'équipe de façon tolérante (lowercase, accents ignorés)

function normaliser(nom: string): string {
  return nom.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function trouverEventSofascore(
  events: SfEvent[],
  homeTeam: string,
  awayTeam: string,
): SfEvent | null {
  const h = normaliser(homeTeam);
  const a = normaliser(awayTeam);

  for (const ev of events) {
    const evH = normaliser(ev.homeTeam.name);
    const evA = normaliser(ev.awayTeam.name);

    // Correspondance exacte ou inclusion partielle (ex: "Paris SG" ↔ "Paris Saint-Germain")
    if (
      (evH.includes(h) || h.includes(evH)) &&
      (evA.includes(a) || a.includes(evA))
    ) {
      return ev;
    }
  }
  return null;
}

// ─── Résumé H2H formaté pour Groq ────────────────────────────────────────────

export function resumerH2HGroq(events: SfEvent[], homeTeam: string, awayTeam: string): string {
  if (!events.length) return 'Historique H2H non disponible';

  const lignes: string[] = ['Historique H2H (10 derniers matchs) :'];
  for (const e of events) {
    const date  = new Date(e.startTimestamp * 1000).toLocaleDateString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const hsc = e.homeScore?.current ?? e.homeScore?.display ?? '?';
    const asc = e.awayScore?.current ?? e.awayScore?.display ?? '?';
    lignes.push(`  ${date} — ${e.homeTeam.name} ${hsc}-${asc} ${e.awayTeam.name}`);
  }
  return lignes.join('\n');
}
