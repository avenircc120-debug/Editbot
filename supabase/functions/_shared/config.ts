// ─── Configuration centralisée — Architecture hybride ────────────────────────
// Source 1 : TheSportsDB  → calendrier des matchs + stats de base
// Source 2 : api-football → stats détaillées (possession, cartons, corners)

// ─── TheSportsDB ─────────────────────────────────────────────────────────────
export const THESPORTSDB = {
  BASE_URL: 'https://www.thesportsdb.com/api/v1/json',
  // Clé env THESPORTSDB_KEY ; fallback '3' = tier gratuit public
  get KEY(): string {
    return Deno.env.get('THESPORTSDB_KEY') ?? '3';
  },
};

// ─── api-football (RapidAPI) ──────────────────────────────────────────────────
export const APIFOOTBALL = {
  BASE_URL: 'https://api-football-v1.p.rapidapi.com/v3',
  HOST:     'api-football-v1.p.rapidapi.com',
};

// ─── Groq ─────────────────────────────────────────────────────────────────────
export const GROQ = {
  BASE_URL:   'https://api.groq.com/openai/v1',
  MODEL:      'llama3-70b-8192',
  MAX_TOKENS: 800,
  CACHE_H:    24,   // validité du pronostic en cache (heures)
};

// ─── Ligues supportées ────────────────────────────────────────────────────────
// tsdb_id   : ID TheSportsDB
// apif_id   : ID api-football.com (pour les stats détaillées)
export const LEAGUES: Array<{
  tsdb_id:  string;
  apif_id:  string;
  name:     string;
}> = [
  { tsdb_id: '4334', apif_id: '61',  name: 'Ligue 1'          },
  { tsdb_id: '4328', apif_id: '39',  name: 'Premier League'   },
  { tsdb_id: '4335', apif_id: '140', name: 'La Liga'          },
  { tsdb_id: '4331', apif_id: '78',  name: 'Bundesliga'       },
  { tsdb_id: '4332', apif_id: '135', name: 'Serie A'          },
  { tsdb_id: '4480', apif_id: '2',   name: 'Champions League' },
  { tsdb_id: '4481', apif_id: '3',   name: 'Europa League'    },
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
