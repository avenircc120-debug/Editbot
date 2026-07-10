/**
 * ─── MASAP Market Mapper ─────────────────────────────────────────────────────
 * Normalise dynamiquement TOUS les marchés de n'importe quelle source/bookmaker
 * vers des clés standardisées pour le stockage JSONB dans marches_bookmakers.
 *
 * Clés standardisées :
 *   1x2           | btts          | double_chance  | over_under
 *   corners       | cartons       | score_exact    | mi_temps
 *   handicap      | mi_temps_ft   | premier_but    | dernier_but
 *   mi_temps_ou   | corners_mi    | cartons_mi     | equipe_buts
 *   clean_sheet   | anytime_score | handicap_eu    | draw_no_bet
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarcheNormalise {
  cle: CleMarche;                          // Clé standardisée
  label: string;                           // Nom d'origine du bookmaker
  type: TypeMarche;
  valeurs?: Record<string, number>;        // Pour marchés sans ligne (1X2, BTTS…)
  lignes?: Record<string, Record<string, number>>; // Pour marchés avec lignes (OU, corners…)
}

export type TypeMarche = 'simple' | 'avec_ligne' | 'score' | 'liste';

export type CleMarche =
  | '1x2'          | 'btts'         | 'double_chance' | 'over_under'
  | 'corners'      | 'cartons'      | 'score_exact'   | 'mi_temps'
  | 'handicap'     | 'mi_temps_ft'  | 'premier_but'   | 'dernier_but'
  | 'mi_temps_ou'  | 'corners_mi'   | 'cartons_mi'    | 'equipe_buts'
  | 'clean_sheet'  | 'anytime_score'| 'handicap_eu'   | 'draw_no_bet'
  | 'unknown';

/** Structure finale stockée dans marche_donnees.marches[clé] */
export type MarchesDonnees = {
  meta: {
    source:          string;
    bookmaker_id?:   number;
    fixture_apif_id: number;
    fetch_at:        string;
  };
  marches: Record<CleMarche | string, MarchePayload>;
};

export type MarchePayload =
  | { label: string; valeurs: Record<string, number> }           // simple
  | { label: string; lignes: Record<string, Record<string, number>> }  // avec ligne

// ─── Table de mapping : nom API → clé standard ───────────────────────────────

const MAPPING_CLES: Array<{ patterns: RegExp[]; cle: CleMarche; type: TypeMarche }> = [
  // ── 1X2 / Résultat match ────────────────────────────────────────────────────
  {
    cle: '1x2', type: 'simple',
    patterns: [
      /^match.?winner$/i, /^(ft.?)?1x2$/i, /^result$/i,
      /^(full.?time.?)?result$/i, /^match.?result$/i, /^3.?way$/i,
      /^résultat.?(du.?match)?$/i, /^1\s?x\s?2$/i,
    ],
  },
  // ── BTTS ─────────────────────────────────────────────────────────────────────
  {
    cle: 'btts', type: 'simple',
    patterns: [
      /^both.?teams.?(to.?)?score$/i, /^btts$/i, /^gg\/?ng$/i,
      /^les.?deux.?équipes.?marquent$/i, /^goal.?goal$/i,
    ],
  },
  // ── Double Chance ────────────────────────────────────────────────────────────
  {
    cle: 'double_chance', type: 'simple',
    patterns: [/^double.?chance$/i, /^dc$/i],
  },
  // ── Over/Under (buts) ────────────────────────────────────────────────────────
  {
    cle: 'over_under', type: 'avec_ligne',
    patterns: [
      /^goals.?over.?under$/i, /^(total.?)?goals$/i, /^o\/u$/i,
      /^over.?under.?(goals)?$/i, /^plus\/moins$/i,
      /^(total.?)?buts$/i, /^goal.?line$/i,
    ],
  },
  // ── Corners ─────────────────────────────────────────────────────────────────
  {
    cle: 'corners', type: 'avec_ligne',
    patterns: [
      /^corner.?(over.?under|o\/u)?$/i, /^corners$/i,
      /^(total.?)?corners$/i, /^coups.?de.?coin$/i,
    ],
  },
  // ── Corners mi-temps ────────────────────────────────────────────────────────
  {
    cle: 'corners_mi', type: 'avec_ligne',
    patterns: [/^(1st.?half|ht).?corners$/i, /^corners.?(1ère|first|ht).?mi.?temps$/i],
  },
  // ── Cartons ─────────────────────────────────────────────────────────────────
  {
    cle: 'cartons', type: 'avec_ligne',
    patterns: [
      /^cards?$/i, /^(total.?)?cards?$/i, /^(total.?)?cartons?$/i,
      /^(booking|card).?(over.?under|o\/u)$/i,
    ],
  },
  // ── Cartons mi-temps ────────────────────────────────────────────────────────
  {
    cle: 'cartons_mi', type: 'avec_ligne',
    patterns: [/^(1st.?half|ht).?cards?$/i, /^cartons?.?(mi.?temps|ht)$/i],
  },
  // ── Score exact ─────────────────────────────────────────────────────────────
  {
    cle: 'score_exact', type: 'score',
    patterns: [
      /^correct.?score$/i, /^exact.?score$/i, /^score.?exact$/i,
      /^final.?score$/i, /^score$/i,
    ],
  },
  // ── Mi-temps résultat ────────────────────────────────────────────────────────
  {
    cle: 'mi_temps', type: 'simple',
    patterns: [
      /^(1st.?half|first.?half|ht).?(result|winner)?$/i, /^half.?time.?(result)?$/i,
      /^mi.?temps.?(résultat)?$/i, /^ht.?1x2$/i,
    ],
  },
  // ── Mi-temps / Plein temps ───────────────────────────────────────────────────
  {
    cle: 'mi_temps_ft', type: 'simple',
    patterns: [
      /^half.?time.?\/?full.?time$/i, /^ht\/?ft$/i,
      /^mi.?temps.?\/?.?(fin|full|plein).?temps$/i,
    ],
  },
  // ── Mi-temps Over/Under ─────────────────────────────────────────────────────
  {
    cle: 'mi_temps_ou', type: 'avec_ligne',
    patterns: [
      /^(1st.?half|ht).?(goals.?)?over.?under$/i,
      /^(1st.?half|ht).?total.?goals$/i,
    ],
  },
  // ── Handicap asiatique ───────────────────────────────────────────────────────
  {
    cle: 'handicap', type: 'avec_ligne',
    patterns: [
      /^asian.?handicap$/i, /^ah$/i, /^handicap.?asiatique$/i,
    ],
  },
  // ── Handicap européen ────────────────────────────────────────────────────────
  {
    cle: 'handicap_eu', type: 'avec_ligne',
    patterns: [
      /^(european.?)?handicap$/i, /^(3.?way.?)?handicap.?(européen)?$/i,
    ],
  },
  // ── Draw No Bet ─────────────────────────────────────────────────────────────
  {
    cle: 'draw_no_bet', type: 'simple',
    patterns: [/^draw.?no.?bet$/i, /^dnb$/i],
  },
  // ── Premier buteur ──────────────────────────────────────────────────────────
  {
    cle: 'premier_but', type: 'liste',
    patterns: [/^first.?goal.?scorer$/i, /^premier.?buteur$/i, /^first.?scorer$/i],
  },
  // ── Dernier buteur ──────────────────────────────────────────────────────────
  {
    cle: 'dernier_but', type: 'liste',
    patterns: [/^last.?goal.?scorer$/i, /^dernier.?buteur$/i],
  },
  // ── Buteur à tout moment ─────────────────────────────────────────────────────
  {
    cle: 'anytime_score', type: 'liste',
    patterns: [/^anytime.?goal.?scorer$/i, /^buteur.?(à.?tout.?moment)?$/i],
  },
  // ── Buts équipe ─────────────────────────────────────────────────────────────
  {
    cle: 'equipe_buts', type: 'avec_ligne',
    patterns: [
      /^(home|away).?team?.?(total.?)?goals?/i,
      /^team.?(total.?)?goals?/i,
      /^buts.?(domicile|extérieur)/i,
    ],
  },
  // ── Clean sheet ─────────────────────────────────────────────────────────────
  {
    cle: 'clean_sheet', type: 'simple',
    patterns: [/^clean.?sheet$/i, /^(home|away).?clean.?sheet$/i],
  },
];

// ─── Mapping des sélections (valeurs) vers clés standard ─────────────────────

const MAPPING_SELECTIONS: Record<string, string> = {
  // 1X2
  'home':       'domicile',
  'draw':       'nul',
  'away':       'exterieur',
  'home win':   'domicile',
  'draw':       'nul',
  'away win':   'exterieur',
  '1':          'domicile',
  'x':          'nul',
  '2':          'exterieur',
  // BTTS
  'yes':        'oui',
  'no':         'non',
  // Double Chance
  '1x':         '1X',
  'x2':         'X2',
  '12':         '12',
  // Over/Under
  'over':       'over',
  'under':      'under',
  // Clean Sheet
  'yes':        'oui',
  'no':         'non',
};

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Normalise une valeur de sélection vers la clé standardisée.
 */
function normaliserSelection(valeur: string): string {
  const lower = valeur.toLowerCase().trim();
  return MAPPING_SELECTIONS[lower] ?? valeur;
}

/**
 * Extrait la ligne numérique d'un label de cote.
 * Ex: "Over 2.5" → "2.5", "Under 8.5 corners" → "8.5"
 */
function extraireLigne(valeur: string): string | null {
  const match = valeur.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/**
 * Détermine si la sélection est 'over' ou 'under' (pour marchés avec lignes).
 */
function extraireDirection(valeur: string): string {
  const lower = valeur.toLowerCase();
  if (lower.includes('over') || lower.startsWith('plus de')) return 'over';
  if (lower.includes('under') || lower.startsWith('moins de')) return 'under';
  return normaliserSelection(valeur);
}

// ─── Résolution de la clé de marché ──────────────────────────────────────────

/**
 * Trouve la clé standard pour un nom de marché donné par le bookmaker.
 * Retourne 'unknown' si aucun pattern ne correspond.
 */
export function resoudreCleMarche(nomMarche: string): { cle: CleMarche; type: TypeMarche } {
  for (const { patterns, cle, type } of MAPPING_CLES) {
    for (const pattern of patterns) {
      if (pattern.test(nomMarche.trim())) {
        return { cle, type };
      }
    }
  }
  return { cle: 'unknown', type: 'simple' };
}

// ─── Parseur de bet values api-football ──────────────────────────────────────

interface ApifBet {
  id:     number;
  name:   string;
  values: Array<{ value: string; odd: string }>;
}

/**
 * Convertit un `bet` de l'API api-football en MarcheNormalise.
 * Compatible avec la réponse de /odds?fixture={id}.
 *
 * @param bet     Objet { id, name, values[] } retourné par l'API
 * @returns       MarcheNormalise | null si marché ignoré
 */
export function mapperMarche(bet: ApifBet): MarcheNormalise | null {
  const { cle, type } = resoudreCleMarche(bet.name);

  if (type === 'liste') return null; // On ignore les listes de buteurs (trop volumineuses)

  if (type === 'avec_ligne') {
    // Regroupe les valeurs par ligne numérique
    const lignes: Record<string, Record<string, number>> = {};

    for (const v of bet.values) {
      const ligne = extraireLigne(v.value);
      if (!ligne) continue;
      const direction = extraireDirection(v.value);
      const cote = parseFloat(v.odd);
      if (isNaN(cote) || cote <= 0) continue;

      if (!lignes[ligne]) lignes[ligne] = {};
      lignes[ligne][direction] = cote;
    }

    if (Object.keys(lignes).length === 0) return null;

    return { cle, label: bet.name, type, lignes };
  }

  if (type === 'score') {
    // Score exact : value = "Home 2:1", "Away 0:0", "1:0" — on normalise en "2-1"
    const valeurs: Record<string, number> = {};
    for (const v of bet.values) {
      const cote = parseFloat(v.odd);
      if (isNaN(cote) || cote <= 0) continue;
      // Normalise "2:1", "Home 2:1", "Away 0:1" → "2-1", "0-1"
      const scoreMatch = v.value.match(/(\d+)[:\-](\d+)/);
      const score = scoreMatch
        ? `${scoreMatch[1]}-${scoreMatch[2]}`
        : v.value.replace(/[: ]/g, '-');
      valeurs[score] = cote;
    }
    if (Object.keys(valeurs).length === 0) return null;
    return { cle, label: bet.name, type, valeurs };
  }

  // type === 'simple'
  const valeurs: Record<string, number> = {};
  for (const v of bet.values) {
    const cote = parseFloat(v.odd);
    if (isNaN(cote) || cote <= 0) continue;
    const sel = normaliserSelection(v.value);
    valeurs[sel] = cote;
  }

  if (Object.keys(valeurs).length === 0) return null;
  return { cle, label: bet.name, type, valeurs };
}

// ─── Assemblage du JSONB final ────────────────────────────────────────────────

/**
 * Construit le JSONB marche_donnees complet à partir des bets api-football.
 * Prêt à être inséré dans marches_bookmakers.marche_donnees.
 */
export function construireMarcheDonnees(
  bets: ApifBet[],
  fixtureApifId: number,
  source = 'api-football'
): MarchesDonnees {
  const marches: Record<string, MarchePayload> = {};

  for (const bet of bets) {
    const normalise = mapperMarche(bet);
    if (!normalise) continue;

    const { cle, label, type, valeurs, lignes } = normalise as any;

    if (cle === 'unknown') {
      // Stocke quand même sous la clé brute pour ne rien perdre
      const cleRaw = bet.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      if (valeurs && Object.keys(valeurs).length > 0) {
        marches[cleRaw] = { label, valeurs };
      } else if (lignes && Object.keys(lignes).length > 0) {
        marches[cleRaw] = { label, lignes };
      }
      continue;
    }

    if (lignes) {
      marches[cle] = { label, lignes };
    } else if (valeurs) {
      marches[cle] = { label, valeurs };
    }
  }

  return {
    meta: {
      source,
      fixture_apif_id: fixtureApifId,
      fetch_at: new Date().toISOString(),
    },
    marches,
  };
}

// ─── The Odds API : construction directe (markets déjà standardisés) ─────────
// The Odds API renvoie des clés de marché déjà normalisées ('h2h', 'totals',
// 'spreads' = handicap asiatique), pas besoin de la table de mapping ci-dessus
// — juste une conversion de format vers MarchesDonnees.
// NB: 'btts' n'est PAS supporté par l'endpoint /odds de The Odds API (422),
// contrairement à ce que documentait cette section avant — retiré.

export interface OddsApiMarket {
  key:      string;
  outcomes: Array<{ name: string; price: number; point?: number }>;
}

export function construireMarcheDonneesOddsApi(
  markets: OddsApiMarket[],
  homeTeam: string,
  awayTeam: string,
  matchId: string,
  source = 'the-odds-api',
): MarchesDonnees {
  const marches: Record<string, MarchePayload> = {};

  for (const market of markets) {
    if (market.key === 'h2h') {
      const valeurs: Record<string, number> = {};
      for (const o of market.outcomes) {
        if (o.name === homeTeam) valeurs.domicile = o.price;
        else if (o.name === awayTeam) valeurs.exterieur = o.price;
        else if (/draw/i.test(o.name)) valeurs.nul = o.price;
      }
      if (Object.keys(valeurs).length) marches['1x2'] = { label: 'Match Winner', valeurs };
    }

    if (market.key === 'spreads') {
      // Handicap asiatique : chaque outcome porte une 'point' (ligne) propre à
      // l'équipe (ex: Arsenal -2, Coventry +2) — on regroupe par ligne absolue.
      const lignes: Record<string, Record<string, number>> = {};
      for (const o of market.outcomes) {
        if (o.point === undefined) continue;
        const ligne = String(Math.abs(o.point));
        if (!lignes[ligne]) lignes[ligne] = {};
        if (o.name === homeTeam) lignes[ligne].domicile = o.price;
        else if (o.name === awayTeam) lignes[ligne].exterieur = o.price;
      }
      if (Object.keys(lignes).length) marches['handicap'] = { label: 'Asian Handicap', lignes };
    }

    if (market.key === 'totals') {
      const lignes: Record<string, Record<string, number>> = {};
      for (const o of market.outcomes) {
        if (o.point === undefined) continue;
        const ligne = String(o.point);
        if (!lignes[ligne]) lignes[ligne] = {};
        if (/^over$/i.test(o.name)) lignes[ligne].over = o.price;
        else if (/^under$/i.test(o.name)) lignes[ligne].under = o.price;
      }
      if (Object.keys(lignes).length) marches['over_under'] = { label: 'Total Goals', lignes };
    }
  }

  return {
    meta: {
      source,
      fixture_apif_id: 0, // non applicable (The Odds API n'utilise pas d'ID api-football)
      match_id: matchId,
      fetch_at: new Date().toISOString(),
    } as any,
    marches,
  };
}
