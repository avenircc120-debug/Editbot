/**
 * Modèle statistique Poisson — calcul de probabilités "haut degré"
 *
 * Principe : les buts marqués par une équipe dans un match suivent
 * approximativement une loi de Poisson. En estimant le nombre moyen de buts
 * attendus (lambda) pour chaque équipe à partir de ses derniers matchs
 * (buts marqués/concédés), on peut calculer mathématiquement — et non par
 * simple estimation qualitative — la probabilité de chaque issue :
 * 1X2, BTTS, Over/Under, double chance, et le score exact le plus probable.
 *
 * C'est un complément quantitatif au raisonnement qualitatif de Groq :
 * Groq reçoit ces probabilités calculées et doit s'en servir comme base
 * principale, en les ajustant seulement avec le contexte (compos, cotes…).
 */

export interface ResultatMatch {
  buts_pour:    number;
  buts_contre:  number;
}

/** Extrait buts marqués/concédés d'une équipe sur ses N derniers matchs (TheSportsDB) */
export function extraireResultats(matchs: any[], teamId: string, max = 6): ResultatMatch[] {
  const out: ResultatMatch[] = [];
  for (const m of matchs.slice(0, max)) {
    const home = m.idHomeTeam === teamId;
    const away = m.idAwayTeam === teamId;
    if (!home && !away) continue;
    const hs = Number(m.intHomeScore);
    const as = Number(m.intAwayScore);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    out.push(home ? { buts_pour: hs, buts_contre: as } : { buts_pour: as, buts_contre: hs });
  }
  return out;
}

function moyenne(vals: number[], fallback: number): number {
  if (!vals.length) return fallback;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const MOYENNE_LIGUE_BUTS = 1.35; // moyenne buts/équipe/match approximative (référentiel généraliste)
const AVANTAGE_DOMICILE  = 1.12; // léger surplus statistique pour l'équipe à domicile

/**
 * Estime lambda (buts attendus) pour l'équipe à domicile et l'équipe à
 * l'extérieur, à partir de leur forme récente (attaque propre + défense adverse).
 * Si aucune donnée n'est disponible, retombe sur la moyenne générale (pas de biais).
 */
export function estimerLambdas(
  formeHome: ResultatMatch[],
  formeAway: ResultatMatch[],
): { lambdaHome: number; lambdaAway: number; fiabiliteDonnees: 'faible' | 'moyenne' | 'bonne' } {
  const attHome = moyenne(formeHome.map(r => r.buts_pour),   MOYENNE_LIGUE_BUTS);
  const defHome = moyenne(formeHome.map(r => r.buts_contre), MOYENNE_LIGUE_BUTS);
  const attAway = moyenne(formeAway.map(r => r.buts_pour),   MOYENNE_LIGUE_BUTS);
  const defAway = moyenne(formeAway.map(r => r.buts_contre), MOYENNE_LIGUE_BUTS);

  // Buts attendus domicile = moyenne(attaque dom, défense adverse) x avantage domicile
  const lambdaHome = ((attHome + defAway) / 2) * AVANTAGE_DOMICILE;
  const lambdaAway = (attAway + defHome) / 2;

  const nbMatchs = Math.min(formeHome.length, formeAway.length);
  const fiabiliteDonnees = nbMatchs >= 5 ? 'bonne' : nbMatchs >= 2 ? 'moyenne' : 'faible';

  return {
    lambdaHome: Math.max(0.2, lambdaHome),
    lambdaAway: Math.max(0.2, lambdaAway),
    fiabiliteDonnees,
  };
}

function factorielle(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k: number, lambda: number): number {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorielle(k);
}

export interface ProbabilitesMatch {
  lambdaHome: number;
  lambdaAway: number;
  fiabiliteDonnees: string;
  p1x2:        { domicile: number; nul: number; exterieur: number };
  doubleChance: { '1N': number; '12': number; 'N2': number };
  btts:        { oui: number; non: number };
  overUnder25: { plus: number; moins: number };
  overUnder35: { plus: number; moins: number };
  scoreExactTop3: Array<{ score: string; probabilite: number }>;
}

const MAX_BUTS = 7; // matrice 0..7 buts par équipe, largement suffisant

export function calculerProbabilites(lambdaHome: number, lambdaAway: number, fiabiliteDonnees: string): ProbabilitesMatch {
  const matrice: number[][] = [];
  for (let i = 0; i <= MAX_BUTS; i++) {
    matrice[i] = [];
    for (let j = 0; j <= MAX_BUTS; j++) {
      matrice[i][j] = poisson(i, lambdaHome) * poisson(j, lambdaAway);
    }
  }

  let pDomicile = 0, pNul = 0, pExterieur = 0;
  let pBtts = 0, pOver25 = 0, pOver35 = 0;
  const scores: Array<{ score: string; probabilite: number }> = [];

  for (let i = 0; i <= MAX_BUTS; i++) {
    for (let j = 0; j <= MAX_BUTS; j++) {
      const p = matrice[i][j];
      if (i > j) pDomicile += p;
      else if (i === j) pNul += p;
      else pExterieur += p;

      if (i >= 1 && j >= 1) pBtts += p;
      if (i + j > 2.5) pOver25 += p;
      if (i + j > 3.5) pOver35 += p;

      scores.push({ score: `${i}-${j}`, probabilite: p });
    }
  }

  scores.sort((a, b) => b.probabilite - a.probabilite);

  const pct = (v: number) => Math.round(v * 1000) / 10; // 1 décimale, en %

  return {
    lambdaHome: Math.round(lambdaHome * 100) / 100,
    lambdaAway: Math.round(lambdaAway * 100) / 100,
    fiabiliteDonnees,
    p1x2: { domicile: pct(pDomicile), nul: pct(pNul), exterieur: pct(pExterieur) },
    doubleChance: {
      '1N': pct(pDomicile + pNul),
      '12': pct(pDomicile + pExterieur),
      'N2': pct(pNul + pExterieur),
    },
    btts: { oui: pct(pBtts), non: pct(1 - pBtts) },
    overUnder25: { plus: pct(pOver25), moins: pct(1 - pOver25) },
    overUnder35: { plus: pct(pOver35), moins: pct(1 - pOver35) },
    scoreExactTop3: scores.slice(0, 3).map(s => ({ score: s.score, probabilite: pct(s.probabilite) })),
  };
}

/** Formatte les probabilités calculées en texte lisible pour le contexte Groq */
export function formatProbabilitesPourGroq(p: ProbabilitesMatch, homeTeam: string, awayTeam: string): string {
  return `--- CALCULS STATISTIQUES (modèle Poisson, buts attendus réels) ---
Buts attendus : ${homeTeam} ${p.lambdaHome} | ${awayTeam} ${p.lambdaAway} (fiabilité des données sources : ${p.fiabiliteDonnees})
1X2 calculé   : Victoire dom. ${p.p1x2.domicile}% | Nul ${p.p1x2.nul}% | Victoire ext. ${p.p1x2.exterieur}%
Double chance : 1N ${p.doubleChance['1N']}% | 12 ${p.doubleChance['12']}% | N2 ${p.doubleChance['N2']}%
BTTS calculé  : Oui ${p.btts.oui}% | Non ${p.btts.non}%
Over/Under 2.5: Plus ${p.overUnder25.plus}% | Moins ${p.overUnder25.moins}%
Over/Under 3.5: Plus ${p.overUnder35.plus}% | Moins ${p.overUnder35.moins}%
Scores les plus probables : ${p.scoreExactTop3.map(s => `${s.score} (${s.probabilite}%)`).join(', ')}
=> Utilise ces probabilités calculées comme base quantitative principale de ton pronostic. Ajuste-les seulement si les compositions, l'historique H2H ou les cotes du marché indiquent un facteur non capturé par ce modèle (ex: absence d'un titulaire clé, calendrier chargé, enjeu du match).`;
}
