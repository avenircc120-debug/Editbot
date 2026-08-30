/**
 * espn.ts — Client de l'API ESPN via notre proxy Cloudflare (scores en direct)
 *
 * ESPN bloque les appels directs depuis Supabase Edge par réputation d'IP.
 * Le proxy Cloudflare ajoute les en-têtes navigateur nécessaires, limite la
 * cible à l'endpoint scoreboard ESPN et conserve un cache très court pour
 * réduire la pression sur la source sans retarder les scores en direct.
 */

const ESPN_PROXY_URL = Deno.env.get('ESPN_PROXY_URL') ?? 'https://editbot-espn-proxy.avenircc120.workers.dev';
const ESPN_PROXY_TOKEN = Deno.env.get('ESPN_PROXY_TOKEN') ?? '';
export interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team: { id?: string; displayName: string; shortDisplayName?: string };
  score?: string;
}

export interface EspnStatus {
  displayClock?: string;
  clock?: number;
  type: {
    state: 'pre' | 'in' | 'post';
    completed: boolean;
    description: string;
    detail?: string;
    shortDetail?: string;
  };
}

/** Un événement de match ESPN (but, carton...) — "scoringPlay" + équipe créditée
 *  du but permettent de reconstituer qui a marqué, sans appel API supplémentaire :
 *  cette donnée est déjà présente dans la même réponse que le score/chrono. */
export interface EspnGoalDetail {
  type: { text: string };
  clock?: { value?: number; displayValue?: string };
  team: { id?: string };
  scoringPlay?: boolean;
  ownGoal?: boolean;
  athletesInvolved?: Array<{ displayName: string }>;
}

export interface EspnEvent {
  id: string;
  status: EspnStatus;
  competitions: Array<{
    competitors: EspnCompetitor[];
    status?: EspnStatus;
    details?: EspnGoalDetail[];
  }>;
}

/** tournament_id TheSportsDB (voir _shared/config.ts LEAGUES) → slug ESPN. */
export const ESPN_LEAGUE_SLUGS: Record<string, string> = {
  '4334': 'fra.1',            // Ligue 1
  '4328': 'eng.1',            // Premier League
  '4335': 'esp.1',            // La Liga
  '4331': 'ger.1',            // Bundesliga
  '4332': 'ita.1',            // Serie A
  '4480': 'uefa.champions',   // Champions League
  '4481': 'uefa.europa',      // Europa League
  '4329': 'eng.2',            // Championship
  '4337': 'ned.1',            // Eredivisie
  '4344': 'por.1',            // Primeira Liga
  '4346': 'usa.1',            // MLS
  '4351': 'bra.1',            // Brasileirao
  '4350': 'mex.1',            // Liga MX
  '4406': 'arg.1',            // Liga Argentina
  '4359': 'chn.1',            // Chinese Super League
  '4429': 'fifa.world',       // Coupe du Monde FIFA
  '4330': 'sco.1',            // Scottish Premiership
  '4339': 'tur.1',            // Turkish Super Lig
  '4355': 'rus.1',            // Russian Premier League
  '4356': 'aus.1',            // Australian A-League
};

/** Normalise un nom d'équipe pour la comparaison (minuscules, sans accents/préfixes/ponctuation). */
export function normaliserNomEquipe(nom: string): string {
  return nom
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|ac|as|us|rc|ss|ssc|ud|cd)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Sans paramètre `dates`, ESPN se cale sur "aujourd'hui" dans son propre
 *  fuseau (pas UTC) : un match de notre fenêtre peut donc tomber sur "hier"
 *  de son point de vue et disparaître du programme par défaut (constaté en
 *  production : Tijuana–Pumas, coup d'envoi 03:10 UTC, absent sans ce
 *  paramètre). On précise donc explicitement les dates UTC couvertes par
 *  notre fenêtre -4h/+15min (au plus 2 jours civils UTC).
 *
 *  "Hier" n'est utile que tôt le matin UTC (un match commencé juste après
 *  minuit UTC peut encore tomber sur "hier" côté ESPN) : l'inclure toute la
 *  journée doublait inutilement le nombre d'appels proxy Cloudflare (donc le risque
 *  de 429), pour un cas qui ne se produit que quelques heures par jour. */
function datesUtcCouvertes(): string[] {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const now = new Date();
  if (now.getUTCHours() >= 4) return [fmt(now)];
  const hier = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [...new Set([fmt(hier), fmt(now)])];
}

/** Diagnostic du dernier appel getEspnEvents() — un {slug, date, statut,
 *  count} par requête, pour déboguer sans dépendre des logs plateforme. */
export let lastFetchDiagnostics: Array<{ slug: string; date: string; statut: string; count: number }> = [];

async function espnGet(slug: string, dateStr: string): Promise<EspnEvent[]> {
  const cible = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${dateStr}`;
  // Sans clé proxy Cloudflare configurée, on tente quand même l'appel direct (utile
  // en local/dev, ou si ESPN débloque un jour cette IP) plutôt que d'échouer
  // silencieusement.
  const url = ESPN_PROXY_URL
    ? (() => {
        const proxyUrl = new URL(ESPN_PROXY_URL);
        proxyUrl.searchParams.set('url', cible);
        return proxyUrl.toString();
      })()
    : cible;
  const requestHeaders: Record<string, string> = { 'Accept': 'application/json' };
  if (ESPN_PROXY_TOKEN) requestHeaders.Authorization = `Bearer ${ESPN_PROXY_TOKEN}`;
  try {
    const res = await fetch(url, { headers: requestHeaders });
    if (!res.ok) {
      lastFetchDiagnostics.push({ slug, date: dateStr, statut: `HTTP ${res.status}`, count: 0 });
      console.warn(`[espn] HTTP ${res.status} — ${slug} (${dateStr})`);
      return [];
    }
    const data = await res.json();
    const events = (data?.events ?? []) as EspnEvent[];
    lastFetchDiagnostics.push({ slug, date: dateStr, statut: 'ok', count: events.length });
    return events;
  } catch (e) {
    lastFetchDiagnostics.push({
      slug, date: dateStr,
      statut: `exception: ${e instanceof Error ? e.message : String(e)}`,
      count: 0,
    });
    console.warn(`[espn] Erreur réseau — ${slug} (${dateStr}):`, e);
    return [];
  }
}

/** Exécute des tâches asynchrones avec au plus `limite` en vol simultanément
 *  — nécessaire car le plan proxy Cloudflare utilisé ici plafonne à 5 requêtes
 *  concurrentes : un `Promise.all` sans limite dépasse ce plafond dès que
 *  plusieurs compétitions jouent en même temps (typique un samedi
 *  après-midi), et proxy Cloudflare répond alors 429 à tout le surplus. */
async function executerAvecConcurrenceLimitee<T>(
  taches: Array<() => Promise<T>>,
  limite: number,
): Promise<T[]> {
  const resultats: T[] = new Array(taches.length);
  let curseur = 0;
  async function travailleur() {
    while (curseur < taches.length) {
      const i = curseur++;
      resultats[i] = await taches[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, taches.length) }, travailleur));
  return resultats;
}

/** Récupère le programme (avec statut live) des compétitions demandées, pour
 *  les 2 jours civils UTC couverts par la fenêtre de live-cron, en ne
 *  gardant que celles qu'on sait mapper vers un slug ESPN.
 *
 *  `failedSlugs` liste les slugs pour lesquels AU MOINS une requête a
 *  échoué (429 proxy Cloudflare, timeout, etc.) — donc `events` est potentiellement
 *  incomplet pour ces compétitions. Indispensable pour ne jamais confondre
 *  "ESPN dit que ce match n'existe pas aujourd'hui" (vraie absence) avec
 *  "on n'a pas réussi à demander à ESPN" (silence, pas une absence) —
 *  confondre les deux a déjà déclenché une clôture en masse de matchs
 *  encore en direct lors d'un pic de 429 proxy Cloudflare. */
export async function getEspnEvents(
  tournamentIds: string[],
): Promise<{ events: EspnEvent[]; failedSlugs: Set<string> }> {
  lastFetchDiagnostics = [];
  const slugs = [...new Set(tournamentIds.map(id => ESPN_LEAGUE_SLUGS[id]).filter(Boolean))];
  if (!slugs.length) return { events: [], failedSlugs: new Set() };
  const dates = datesUtcCouvertes();
  const taches = slugs.flatMap(slug => dates.map(date => () => espnGet(slug, date).then(events => ({ slug, events }))));
  // Plafond à 4 (< 5) pour garder une marge : cette fonction Edge peut
  // tourner en parallèle d'un autre appel (ex: un retry manuel) sur le
  // même compte proxy Cloudflare.
  const results = await executerAvecConcurrenceLimitee(taches, 4);

  const failedSlugs = new Set<string>();
  const diagBySlug = new Map<string, boolean>(); // slug -> a-au-moins-un-echec
  for (const diag of lastFetchDiagnostics) {
    if (diag.statut !== 'ok') diagBySlug.set(diag.slug, true);
  }
  for (const slug of slugs) if (diagBySlug.get(slug)) failedSlugs.add(slug);

  return { events: results.flatMap(r => r.events), failedSlugs };
}

/** Convertit un état ESPN ('pre' | 'in' | 'post') vers le statut interne Editbot. */
export function statutEspnVersInterne(state: string): string {
  switch (state) {
    case 'in':   return 'inprogress';
    case 'post': return 'finished';
    default:     return 'scheduled';
  }
}

/** Cherche l'événement ESPN correspondant à une paire d'équipes (par nom normalisé). */
export function trouverEvenementEspn(
  events: EspnEvent[],
  homeTeam: string,
  awayTeam: string,
): EspnEvent | null {
  const h = normaliserNomEquipe(homeTeam);
  const a = normaliserNomEquipe(awayTeam);
  if (!h || !a) return null;
  return events.find(ev => {
    const competitors = ev.competitions?.[0]?.competitors ?? [];
    if (competitors.length < 2) return false;
    const eh = normaliserNomEquipe(competitors.find(c => c.homeAway === 'home')?.team.displayName ?? '');
    const ea = normaliserNomEquipe(competitors.find(c => c.homeAway === 'away')?.team.displayName ?? '');
    return eh && ea && (eh.includes(h) || h.includes(eh)) && (ea.includes(a) || a.includes(ea));
  }) ?? null;
}

/** Score courant d'un événement ESPN (0 si absent). */
export function scoreEspn(ev: EspnEvent, homeAway: 'home' | 'away'): number {
  const competitors = ev.competitions?.[0]?.competitors ?? [];
  const c = competitors.find(c => c.homeAway === homeAway);
  return c?.score != null ? Number(c.score) : 0;
}

/** Chronomètre du match — ESPN place parfois displayClock au niveau de
 *  l'event, parfois seulement dans competitions[0].status (selon endpoint/
 *  sport). On essaie les deux emplacements avant d'abandonner. */
export function clockEspn(ev: EspnEvent): string | null {
  return ev.status?.displayClock
    || ev.competitions?.[0]?.status?.displayClock
    || null;
}

/** Id ESPN de l'équipe (home ou away) pour un événement — sert à relier les
 *  buts de `competitions[0].details` à la bonne équipe. */
export function idEquipeEspn(ev: EspnEvent, homeAway: 'home' | 'away'): string | null {
  return ev.competitions?.[0]?.competitors?.find(c => c.homeAway === homeAway)?.team?.id ?? null;
}

/** Liste (dans l'ordre chronologique, séparés par ';') des buteurs d'une équipe
 *  pour ce match, tels que rapportés par ESPN dans `competitions[0].details`.
 *  Les buts contre son camp sont exclus (le nom impliqué appartient à l'équipe
 *  adverse dans le schéma ESPN — l'attribuer aurait été trompeur), auquel cas
 *  le but reste affiché sans nom plutôt que mal attribué. */
export function buteursEquipe(ev: EspnEvent, teamId: string | null): string {
  if (!teamId) return '';
  const details = ev.competitions?.[0]?.details ?? [];
  return details
    .filter(d => d.scoringPlay && !d.ownGoal && d.team?.id === teamId)
    .sort((a, b) => (a.clock?.value ?? 0) - (b.clock?.value ?? 0))
    .map(d => d.athletesInvolved?.[0]?.displayName)
    .filter((nom): nom is string => Boolean(nom))
    .join(';');
}
