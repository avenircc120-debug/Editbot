// ─── Configuration centralisée ────────────────────────────────────────────────
// Source 1 : TheSportsDB  → calendrier des matchs + stats de base
// Source 2 : The Odds API → cotes bookmakers
// (SofaScore retiré — conflit de quota/cron avec The Odds API sur RapidAPI)

// ─── TheSportsDB ─────────────────────────────────────────────────────────────
export const THESPORTSDB = {
  BASE_URL: 'https://www.thesportsdb.com/api/v1/json',
  // Clé env THESPORTSDB_KEY ; fallback '3' = tier gratuit public
  get KEY(): string {
    return Deno.env.get('THESPORTSDB_KEY') ?? '3';
  },
};

// ─── The Odds API ──────────────────────────────────────────────────────────────
// Cotes bookmakers réelles, spécialisé sport (dont soccer). Plan gratuit :
// 500 requêtes/mois. Clé env : ODDS_API_KEY.
// Doc : https://the-odds-api.com/liveapi/guides/v4/
export const ODDS_API = {
  BASE_URL: 'https://api.the-odds-api.com/v4',
  get KEY(): string {
    return Deno.env.get('ODDS_API_KEY') ?? '';
  },
  REGIONS: 'eu',
  MARKETS: 'h2h,totals,btts',
  ODDS_FORMAT: 'decimal',
};

// ─── Groq ─────────────────────────────────────────────────────────────────────
export const GROQ = {
  BASE_URL:   'https://api.groq.com/openai/v1',
  // llama3-70b-8192 a été décommissionné par Groq (juillet 2026)
  MODEL:      'llama-3.3-70b-versatile',
  MAX_TOKENS: 800,
  CACHE_H:    24,   // validité du pronostic en cache (heures)
};

// ─── Ligues supportées ────────────────────────────────────────────────────────
// tsdb_id : ID TheSportsDB
export const LEAGUES: Array<{
  tsdb_id:   string;
  name:      string;
  // Clé sport The Odds API pour les cotes (null = pas de cotes pour cette ligue)
  odds_key?: string;
}> = [
  { tsdb_id: '4334', name: 'Ligue 1',           odds_key: 'soccer_france_ligue_one' },
  { tsdb_id: '4328', name: 'Premier League',    odds_key: 'soccer_epl' },
  { tsdb_id: '4335', name: 'La Liga',           odds_key: 'soccer_spain_la_liga' },
  { tsdb_id: '4331', name: 'Bundesliga',        odds_key: 'soccer_germany_bundesliga' },
  { tsdb_id: '4332', name: 'Serie A',           odds_key: 'soccer_italy_serie_a' },
  { tsdb_id: '4480', name: 'Champions League',  odds_key: 'soccer_uefa_champs_league' },
  { tsdb_id: '4481', name: 'Europa League',     odds_key: 'soccer_uefa_europa_league' },
  { tsdb_id: '4329', name: 'Championship',      odds_key: 'soccer_efl_champ' },
  { tsdb_id: '4330', name: 'Scottish Premiership', odds_key: 'soccer_spl' },
  { tsdb_id: '4337', name: 'Eredivisie',        odds_key: 'soccer_netherlands_eredivisie' },
  { tsdb_id: '4344', name: 'Primeira Liga',     odds_key: 'soccer_portugal_primeira_liga' },
  { tsdb_id: '4346', name: 'MLS',               odds_key: 'soccer_usa_mls' },
  { tsdb_id: '4351', name: 'Brasileirão',       odds_key: 'soccer_brazil_campeonato' },
  { tsdb_id: '4429', name: 'Coupe du Monde FIFA', odds_key: 'soccer_fifa_world_cup' },
];

// ─── Prompt système Groq ──────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `Tu es un expert analyste sportif passionné et rigoureux. Ton rôle est de conseiller les utilisateurs sur leurs paris en te basant sur des données statistiques réelles.

Tu ne te contentes pas de donner des chiffres, tu expliques le "pourquoi" (dynamique d'équipe, état de forme, historique des confrontations).

Règles absolues :
- Sois humain, professionnel et prudent.
- Si une probabilité est faible (< 70%), avertis clairement l'utilisateur du risque.
- Utilise uniquement les données statistiques fournies, ne les invente jamais.
- Structure tes réponses de manière claire et concise.
- Fournis toujours un indice de fiabilité entre 0 et 100.
- Format de réponse JSON strict (voir instructions de chaque appel).`;
