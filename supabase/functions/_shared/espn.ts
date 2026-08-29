/**
 * espn.ts — Client API cachée ESPN (scores en direct)
 *
 * Endpoint public non documenté (site.api.espn.com), sans clé et sans quota
 * connu — remplace SofaScore, qui bloque par réputation d'IP les appels
 * venant de Supabase Edge (403 systématique, confirmé en production, même
 * avec des en-têtes de navigateur).
 *
 * Contrairement à SofaScore (1 seul appel = tout le monde en direct), ESPN
 * n'a pas d'endpoint global : 1 appel = le programme du jour d'UNE
 * compétition (avec le statut de chaque match, live ou pas). On n'appelle
 * donc que les compétitions réellement concernées par les matchs suivis.
 */

export interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team: { displayName: string; shortDisplayName?: string };
  score?: string;
}

export interface EspnEvent {
  id: string;
  status: {
    type: {
      state: 'pre' | 'in' | 'post';
      completed: boolean;
      description: string;
    };
  };
  competitions: Array<{ competitors: EspnCompetitor[] }>;
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
 *  notre fenêtre -4h/+15min (au plus 2 jours civils UTC). */
function datesUtcCouvertes(): string[] {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const now = new Date();
  const hier = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [...new Set([fmt(hier), fmt(now)])];
}

/** Diagnostic du dernier appel getEspnEvents() — un {slug, date, statut,
 *  count} par requête, pour déboguer sans dépendre des logs plateforme. */
export let lastFetchDiagnostics: Array<{ slug: string; date: string; statut: string; count: number }> = [];

async function espnGet(slug: string, dateStr: string): Promise<EspnEvent[]> {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${dateStr}`,
      { headers: { 'Accept': 'application/json' } },
    );
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

/** Récupère le programme (avec statut live) des compétitions demandées, pour
 *  les 2 jours civils UTC couverts par la fenêtre de live-cron, en ne
 *  gardant que celles qu'on sait mapper vers un slug ESPN. */
export async function getEspnEvents(tournamentIds: string[]): Promise<EspnEvent[]> {
  lastFetchDiagnostics = [];
  const slugs = [...new Set(tournamentIds.map(id => ESPN_LEAGUE_SLUGS[id]).filter(Boolean))];
  if (!slugs.length) return [];
  const dates = datesUtcCouvertes();
  const appels = slugs.flatMap(slug => dates.map(date => espnGet(slug, date)));
  const results = await Promise.all(appels);
  return results.flat();
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
