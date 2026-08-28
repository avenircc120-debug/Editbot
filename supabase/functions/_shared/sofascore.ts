/**
 * sofascore.ts — Client non-officiel SofaScore (scores en direct)
 *
 * Endpoint public non documenté, sans clé et sans quota journalier —
 * utilisé en secours pour rattraper les matchs que TheSportsDB/Odds API
 * n'ont pas pu mettre à jour (quota épuisé, ID manquant, source Odds API
 * sans détails live, etc.). 1 seul appel couvre tout le football mondial
 * en direct, donc on peut se le permettre à chaque exécution du cron.
 */

export interface SofaEvent {
  id: number;
  homeTeam: { name: string; shortName?: string };
  awayTeam: { name: string; shortName?: string };
  homeScore?: { current?: number };
  awayScore?: { current?: number };
  status: { code: number; description: string; type: string }; // type: 'notstarted' | 'inprogress' | 'finished' | 'postponed' | 'canceled'
  startTimestamp: number;
}

const BASE_URL = 'https://api.sofascore.com/api/v1';

async function sofaGet(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        // SofaScore renvoie un 403 aux requêtes qui n'ont pas l'air de venir
        // d'un navigateur sur sofascore.com (Referer/Origin absents, UA non
        // reconnu). On imite un vrai onglet ouvert sur le site.
        'Referer': 'https://www.sofascore.com/',
        'Origin':  'https://www.sofascore.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) { console.warn(`[sofascore] HTTP ${res.status} — ${path}`); return null; }
    return await res.json();
  } catch (e) {
    console.warn(`[sofascore] Erreur réseau — ${path}:`, e);
    return null;
  }
}

/** Tous les matchs de football actuellement en direct, dans le monde entier. */
export async function getLiveEventsSofascore(): Promise<SofaEvent[]> {
  const data = await sofaGet('/sport/football/events/live');
  return (data?.events ?? []) as SofaEvent[];
}

/** Normalise un nom d'équipe pour la comparaison (minuscules, sans accents/préfixes/ponctuation). */
export function normaliserNomEquipe(nom: string): string {
  return nom
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|ac|as|us|rc|ss|ssc|ud|cd)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Convertit un statut SofaScore vers le statut interne Editbot. */
export function statutSofaVersInterne(type: string): string {
  switch (type) {
    case 'inprogress': return 'inprogress';
    case 'finished':    return 'finished';
    case 'postponed':
    case 'canceled':
    case 'cancelled':   return 'postponed';
    default:            return 'scheduled';
  }
}

/** Cherche l'événement SofaScore correspondant à une paire d'équipes (par nom normalisé). */
export function trouverEvenementSofascore(
  events: SofaEvent[],
  homeTeam: string,
  awayTeam: string,
): SofaEvent | null {
  const h = normaliserNomEquipe(homeTeam);
  const a = normaliserNomEquipe(awayTeam);
  if (!h || !a) return null;
  return events.find(ev => {
    const eh = normaliserNomEquipe(ev.homeTeam?.name ?? '');
    const ea = normaliserNomEquipe(ev.awayTeam?.name ?? '');
    return eh && ea && (eh.includes(h) || h.includes(eh)) && (ea.includes(a) || a.includes(ea));
  }) ?? null;
}
