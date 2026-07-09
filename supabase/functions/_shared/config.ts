// ─── Configuration centralisée ────────────────────────────────────────────────
// Source 1 : TheSportsDB  → calendrier des matchs + stats de base
// Source 2 : SofaScore    → H2H + enrichissement (via RapidAPI)

// ─── TheSportsDB ─────────────────────────────────────────────────────────────
export const THESPORTSDB = {
  BASE_URL: 'https://www.thesportsdb.com/api/v1/json',
  // Clé env THESPORTSDB_KEY ; fallback '3' = tier gratuit public
  get KEY(): string {
    return Deno.env.get('THESPORTSDB_KEY') ?? '3';
  },
};

// ─── SofaScore (RapidAPI) ─────────────────────────────────────────────────────
export const SOFASCORE = {
  HOST:     'sofascore.p.rapidapi.com',
  BASE_URL: 'https://sofascore.p.rapidapi.com',
  // Quota gratuit : ~500 req/mois → 15/jour (géré dans quota_journalier)
};

// ─── API-Football / odds (RapidAPI) ───────────────────────────────────────────
// Utilisé par odds.ts pour récupérer les cotes bookmakers (endpoint /odds).
// ⚠️ Nécessite un abonnement RapidAPI séparé sur "API-Football" — si non
// souscrit, fetchOdds() échoue proprement (HTTP non-ok, retourne null),
// sans casser le pipeline.
export const APIFOOTBALL = {
  HOST:     'api-football-v1.p.rapidapi.com',
  BASE_URL: 'https://api-football-v1.p.rapidapi.com/v3',
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
  tsdb_id: string;
  name:    string;
}> = [
  { tsdb_id: '4334', name: 'Ligue 1'           },
  { tsdb_id: '4328', name: 'Premier League'    },
  { tsdb_id: '4335', name: 'La Liga'           },
  { tsdb_id: '4331', name: 'Bundesliga'        },
  { tsdb_id: '4332', name: 'Serie A'           },
  { tsdb_id: '4480', name: 'Champions League'  },
  { tsdb_id: '4481', name: 'Europa League'     },
  { tsdb_id: '4329', name: 'Championship'      },
  { tsdb_id: '4330', name: 'Scottish Premiership' },
  { tsdb_id: '4337', name: 'Eredivisie'        },
  { tsdb_id: '4344', name: 'Primeira Liga'     },
  { tsdb_id: '4346', name: 'MLS'               },
  { tsdb_id: '4351', name: 'Brasileirão'       },
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
