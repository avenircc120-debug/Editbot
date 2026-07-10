/**
 * ─── MASAP Odds Module ───────────────────────────────────────────────────────
 * Récupère les cotes bookmakers via The Odds API (the-odds-api.com), plan
 * gratuit (500 requêtes/mois). Un seul appel par ligue renvoie TOUS les
 * matchs à venir de cette ligue avec leurs cotes — on associe ensuite chaque
 * match interne (TheSportsDB) par nom d'équipes + horaire.
 *
 * Documentation : https://the-odds-api.com/liveapi/guides/v4/
 */

import { ODDS_API } from './config.ts';
import { construireMarcheDonneesOddsApi, type MarchesDonnees } from './market-mapper.ts';

// ─── Types réponse The Odds API ───────────────────────────────────────────────

export interface OddsApiEvent {
  id:            string;
  sport_key:     string;
  commence_time: string;
  home_team:     string;
  away_team:     string;
  bookmakers:    OddsApiBookmaker[];
}

interface OddsApiBookmaker {
  key:      string;
  title:    string;
  last_update: string;
  markets:  Array<{
    key:     string; // 'h2h' | 'totals' | 'spreads' (handicap asiatique)
    outcomes: Array<{ name: string; price: number; point?: number }>;
  }>;
}

// ─── Fetch : tous les événements + cotes d'une ligue ──────────────────────────

/**
 * Récupère tous les matchs à venir avec cotes pour une ligue donnée.
 * 1 seul appel API par ligue (consomme 1 requête sur le quota mensuel).
 *
 * @param sportKey  Clé sport The Odds API (ex: 'soccer_epl')
 */
export async function fetchOddsForLeague(sportKey: string): Promise<OddsApiEvent[]> {
  if (!ODDS_API.KEY) {
    console.warn('[odds] ODDS_API_KEY manquant');
    return [];
  }

  const url =
    `${ODDS_API.BASE_URL}/sports/${sportKey}/odds/` +
    `?apiKey=${ODDS_API.KEY}` +
    `&regions=${ODDS_API.REGIONS}` +
    `&markets=${ODDS_API.MARKETS}` +
    `&oddsFormat=${ODDS_API.ODDS_FORMAT}`;

  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (e) {
    console.error(`[odds] Erreur réseau ligue ${sportKey}:`, e);
    return [];
  }

  if (!resp.ok) {
    // 401/422 (ligue inactive/hors saison) ou 429 (quota épuisé) — non-fatal
    console.warn(`[odds] HTTP ${resp.status} pour ${sportKey}`);
    return [];
  }

  const restant = resp.headers.get('x-requests-remaining');
  if (restant) console.log(`[odds] Quota The Odds API restant : ${restant}`);

  try {
    return (await resp.json()) as OddsApiEvent[];
  } catch (e) {
    console.error(`[odds] Réponse JSON invalide pour ${sportKey}:`, e);
    return [];
  }
}

// ─── Association match interne ↔ événement The Odds API ──────────────────────

function normaliserNom(nom: string): string {
  return nom
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire accents
    .replace(/\b(fc|cf|afc|sc|ac|as|cd|ud|club|calcio|de|do|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Trouve l'événement correspondant à un match interne par nom d'équipes
 * (comparaison tolérante) + fenêtre de ±6h autour de l'horaire prévu.
 */
export function trouverEventOdds(
  events: OddsApiEvent[],
  homeTeam: string,
  awayTeam: string,
  matchDateIso: string,
): OddsApiEvent | null {
  const homeN = normaliserNom(homeTeam);
  const awayN = normaliserNom(awayTeam);
  const matchTime = new Date(matchDateIso).getTime();
  const FENETRE_MS = 6 * 3600 * 1000;

  for (const ev of events) {
    const evHomeN = normaliserNom(ev.home_team);
    const evAwayN = normaliserNom(ev.away_team);
    const evTime = new Date(ev.commence_time).getTime();

    const nomsMatch =
      (evHomeN.includes(homeN) || homeN.includes(evHomeN)) &&
      (evAwayN.includes(awayN) || awayN.includes(evAwayN));

    if (nomsMatch && Math.abs(evTime - matchTime) <= FENETRE_MS) {
      return ev;
    }
  }
  return null;
}

// ─── Bookmakers prioritaires (Europe) ─────────────────────────────────────────
const BOOKMAKER_PREFERENCE_ORDER = ['pinnacle', 'bet365', 'unibet_eu', 'williamhill'];

export interface OddsResult {
  matchId:       string;
  bookmakerName: string;
  bookmakerId:   string;
  donnees:       MarchesDonnees;
}

/**
 * Construit le résultat normalisé pour un match à partir d'un événement
 * The Odds API. Sélectionne le bookmaker le plus complet disponible.
 */
export function construireOddsResult(matchId: string, ev: OddsApiEvent): OddsResult | null {
  if (!ev.bookmakers?.length) return null;

  let bookmaker: OddsApiBookmaker | undefined;
  for (const pref of BOOKMAKER_PREFERENCE_ORDER) {
    bookmaker = ev.bookmakers.find((b) => b.key === pref);
    if (bookmaker) break;
  }
  if (!bookmaker) bookmaker = ev.bookmakers[0];

  const donnees = construireMarcheDonneesOddsApi(bookmaker.markets, ev.home_team, ev.away_team, matchId, 'the-odds-api');

  return {
    matchId,
    bookmakerName: bookmaker.title,
    bookmakerId:   bookmaker.key,
    donnees,
  };
}

/**
 * Formate un résumé des marchés clés pour le prompt Groq.
 * Guard défensif : retourne la valeur telle quelle si c'est déjà une string.
 */
export function resumeOddsGroq(donnees: MarchesDonnees | string): string {
  if (typeof donnees === 'string') return donnees;
  const m = donnees.marches;
  const lignes: string[] = [];

  if (m['1x2']?.valeurs) {
    const v = m['1x2'].valeurs as Record<string, number>;
    lignes.push(`1X2 : Dom ${v.domicile ?? '?'} | Nul ${v.nul ?? '?'} | Ext ${v.exterieur ?? '?'}`);
  }
  if (m['handicap']?.lignes) {
    const l = m['handicap'].lignes as Record<string, Record<string, number>>;
    const premiereLigne = Object.keys(l)[0];
    if (premiereLigne) {
      const v = l[premiereLigne];
      lignes.push(`Handicap ±${premiereLigne} : Dom ${v.domicile ?? '?'} | Ext ${v.exterieur ?? '?'}`);
    }
  }
  if (m['over_under']?.lignes) {
    const l = m['over_under'].lignes as Record<string, Record<string, number>>;
    const l25 = l['2.5'];
    if (l25) lignes.push(`O/U 2.5 : Over ${l25.over ?? '?'} | Under ${l25.under ?? '?'}`);
    const l35 = l['3.5'];
    if (l35) lignes.push(`O/U 3.5 : Over ${l35.over ?? '?'} | Under ${l35.under ?? '?'}`);
  }

  return lignes.length > 0
    ? `📊 Cotes (${donnees.meta.source}) :\n` + lignes.map((l) => `  ${l}`).join('\n')
    : '(aucune cote disponible)';
}
