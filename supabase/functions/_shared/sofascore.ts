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

const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.sofascore.com/',
  'Origin':  'https://www.sofascore.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** Diagnostic du dernier appel — utilisé par live-cron pour exposer la cause
 *  réelle d'un échec (403, timeout réseau, etc.) dans sa réponse JSON, le
 *  temps de déboguer sans dépendre des logs de la plateforme. */
export let lastFetchDiagnostic = 'jamais appelé';

/** SofaScore bloque par réputation d'IP les datacenters (Supabase Edge inclus)
 *  avec un 403, quels que soient les en-têtes envoyés — confirmé par
 *  diagnostic. On relaie alors la requête via un proxy public en lecture
 *  seule, qui fait l'appel depuis sa propre IP et renvoie le JSON brut. */
async function sofaGetViaProxy(path: string): Promise<any | null> {
  const target = encodeURIComponent(`${BASE_URL}${path}`);
  // pg_cron/pg_net n'attend live-cron que 5s max côté appelant : un proxy
  // public lent qui dépasserait ce délai ferait échouer TOUT le run (purge
  // comprise) sans qu'on le sache. On coupe donc nous-mêmes avant, pour
  // échouer proprement (sofaCount=0) plutôt que de laisser tout planter.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`https://api.allorigins.win/raw?url=${target}`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      lastFetchDiagnostic = `proxy HTTP ${res.status} ${res.statusText}`;
      console.warn(`[sofascore] proxy HTTP ${res.status} — ${path}`);
      return null;
    }
    const body = await res.json();
    lastFetchDiagnostic = 'ok (via proxy)';
    return body;
  } catch (e) {
    lastFetchDiagnostic = controller.signal.aborted
      ? 'proxy timeout (3.5s)'
      : `proxy exception: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[sofascore] proxy erreur réseau — ${path}:`, e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function sofaGet(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: BROWSER_HEADERS });
    if (!res.ok) {
      lastFetchDiagnostic = `HTTP ${res.status} ${res.statusText}`;
      console.warn(`[sofascore] HTTP ${res.status} — ${path}`);
      // 403 = blocage par réputation d'IP (pas un problème d'en-têtes) →
      // on retente via le proxy plutôt que d'abandonner.
      if (res.status === 403) return await sofaGetViaProxy(path);
      return null;
    }
    lastFetchDiagnostic = 'ok';
    return await res.json();
  } catch (e) {
    lastFetchDiagnostic = `exception: ${e instanceof Error ? e.message : String(e)}`;
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
