/**
 * ─── MASAP Odds Module ───────────────────────────────────────────────────────
 * Récupère TOUS les marchés disponibles pour un match via api-football /odds.
 * Utilise le module market-mapper pour normaliser chaque marché.
 *
 * Endpoint : GET /odds?fixture={id}&bookmaker={id}
 * Documentation : https://www.api-football.com/documentation-v3#tag/Odds
 */

import { APIFOOTBALL } from './config.ts';
import { construireMarcheDonnees, MarchesDonnees } from './market-mapper.ts';

// ─── Types réponse api-football /odds ─────────────────────────────────────────

interface OddsResponse {
  errors:   unknown[];
  results:  number;
  response: OddsFixture[];
}

interface OddsFixture {
  fixture:    { id: number; date: string };
  league:     { id: number; name: string };
  update:     string;
  bookmakers: BookmakerEntry[];
}

interface BookmakerEntry {
  id:   number;
  name: string;
  bets: Array<{ id: number; name: string; values: Array<{ value: string; odd: string }> }>;
}

// ─── Bookmakers prioritaires ──────────────────────────────────────────────────
// On récupère le bookmaker le plus complet en premier (Bet365 ID=6 sur api-football)
// Si absent, on utilise le premier disponible.
const BOOKMAKER_PREFERENCE_ORDER = [6, 8, 16, 1, 2]; // Bet365, Bwin, William Hill…

// ─── Fetch odds ───────────────────────────────────────────────────────────────

/**
 * Résultat d'une récupération de cotes pour un match.
 */
export interface OddsResult {
  fixtureId:     number;
  bookmakerName: string;
  bookmakerId:   number;
  donnees:       MarchesDonnees;
}

/**
 * Récupère toutes les cotes disponibles pour un fixture api-football.
 * Sélectionne automatiquement le bookmaker le plus riche en marchés.
 *
 * @param fixtureId  ID api-football du match
 * @returns          OddsResult | null si aucune cote disponible
 */
export async function fetchOdds(fixtureId: number): Promise<OddsResult | null> {
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) {
    console.warn('[odds] RAPIDAPI_KEY manquant');
    return null;
  }

  const url = `${APIFOOTBALL.BASE_URL}/odds?fixture=${fixtureId}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': APIFOOTBALL.HOST,
      },
    });
  } catch (e) {
    console.error(`[odds] Erreur réseau fixture ${fixtureId}:`, e);
    return null;
  }

  if (!resp.ok) {
    console.error(`[odds] HTTP ${resp.status} pour fixture ${fixtureId}`);
    return null;
  }

  const json: OddsResponse = await resp.json();

  if (!json.response || json.response.length === 0) {
    console.warn(`[odds] Aucune cote disponible pour fixture ${fixtureId}`);
    return null;
  }

  const fixture = json.response[0];
  if (!fixture.bookmakers || fixture.bookmakers.length === 0) {
    console.warn(`[odds] Aucun bookmaker pour fixture ${fixtureId}`);
    return null;
  }

  // Sélectionne le bookmaker prioritaire, sinon le premier disponible
  let bookmaker: BookmakerEntry | undefined;
  for (const prefId of BOOKMAKER_PREFERENCE_ORDER) {
    bookmaker = fixture.bookmakers.find((b) => b.id === prefId);
    if (bookmaker) break;
  }
  if (!bookmaker) bookmaker = fixture.bookmakers[0];

  // Construit le JSONB normalisé via market-mapper
  const donnees = construireMarcheDonnees(bookmaker.bets, fixtureId);
  donnees.meta.bookmaker_id = bookmaker.id;

  const nombreMarches = Object.keys(donnees.marches).length;
  console.log(
    `[odds] Fixture ${fixtureId} | ${bookmaker.name} | ${nombreMarches} marchés normalisés`
  );

  return {
    fixtureId,
    bookmakerName: bookmaker.name,
    bookmakerId:   bookmaker.id,
    donnees,
  };
}

/**
 * Récupère les cotes pour TOUS les bookmakers d'un fixture.
 * Utile pour la vue meilleure_cote_par_match.
 * (Utilise plus de quota — 1 appel API retourne tous les bookmakers)
 */
export async function fetchOddsTousBookmakers(
  fixtureId: number
): Promise<OddsResult[]> {
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) return [];

  const url = `${APIFOOTBALL.BASE_URL}/odds?fixture=${fixtureId}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers: {
      'x-rapidapi-key':  apiKey,
      'x-rapidapi-host': APIFOOTBALL.HOST,
    }});
  } catch (e) {
    console.error(`[odds:all] Erreur réseau fixture ${fixtureId}:`, e);
    return [];
  }

  if (!resp.ok) return [];

  const json: OddsResponse = await resp.json();
  if (!json.response || json.response.length === 0) return [];

  const fixture = json.response[0];
  const results: OddsResult[] = [];

  for (const bk of fixture.bookmakers ?? []) {
    const donnees = construireMarcheDonnees(bk.bets, fixtureId);
    donnees.meta.bookmaker_id = bk.id;
    results.push({
      fixtureId,
      bookmakerName: bk.name,
      bookmakerId:   bk.id,
      donnees,
    });
  }

  console.log(`[odds:all] Fixture ${fixtureId} | ${results.length} bookmakers traités`);
  return results;
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
  if (m['btts']?.valeurs) {
    const v = m['btts'].valeurs as Record<string, number>;
    lignes.push(`BTTS : Oui ${v.oui ?? '?'} | Non ${v.non ?? '?'}`);
  }
  if (m['double_chance']?.valeurs) {
    const v = m['double_chance'].valeurs as Record<string, number>;
    lignes.push(`DC : 1X ${v['1X'] ?? '?'} | X2 ${v['X2'] ?? '?'} | 12 ${v['12'] ?? '?'}`);
  }
  if (m['over_under']?.lignes) {
    const l = m['over_under'].lignes as Record<string, Record<string, number>>;
    const l25 = l['2.5'];
    if (l25) lignes.push(`O/U 2.5 : Over ${l25.over ?? '?'} | Under ${l25.under ?? '?'}`);
    const l35 = l['3.5'];
    if (l35) lignes.push(`O/U 3.5 : Over ${l35.over ?? '?'} | Under ${l35.under ?? '?'}`);
  }
  if (m['corners']?.lignes) {
    const l = m['corners'].lignes as Record<string, Record<string, number>>;
    for (const [ligne, vals] of Object.entries(l)) {
      lignes.push(`Corners ${ligne} : Over ${vals.over ?? '?'} | Under ${vals.under ?? '?'}`);
    }
  }
  if (m['cartons']?.lignes) {
    const l = m['cartons'].lignes as Record<string, Record<string, number>>;
    for (const [ligne, vals] of Object.entries(l)) {
      lignes.push(`Cartons ${ligne} : Over ${vals.over ?? '?'} | Under ${vals.under ?? '?'}`);
    }
  }
  if (m['mi_temps']?.valeurs) {
    const v = m['mi_temps'].valeurs as Record<string, number>;
    lignes.push(`Mi-temps : Dom ${v.domicile ?? '?'} | Nul ${v.nul ?? '?'} | Ext ${v.exterieur ?? '?'}`);
  }

  return lignes.length > 0
    ? `📊 Cotes (${donnees.meta.source}) :\n` + lignes.map((l) => `  ${l}`).join('\n')
    : '(aucune cote disponible)';
}
