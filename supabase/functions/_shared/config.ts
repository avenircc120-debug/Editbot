// Configuration centralisée
export const CONFIG = {
  SOFASCORE_HOST: 'sofascore.p.rapidapi.com',
  SOFASCORE_BASE_URL: 'https://sofascore.p.rapidapi.com',
  GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
  GROQ_MODEL: 'llama3-70b-8192',
  MAX_TOKENS_GROQ: 800,
  CACHE_HOURS: 6, // Durée de validité des pronostics en cache
};

// Compétitions supportées (ID SofaScore → Nom)
export const COMPETITIONS: Record<string, string> = {
  '17':   'Ligue 1',
  '8':    'Premier League',
  '23':   'La Liga',
  '35':   'Bundesliga',
  '23160':'Serie A',
  '7':    'Champions League',
  '679':  'Europa League',
};

// Prompt système permanent pour Groq
export const SYSTEM_PROMPT = `Tu es un expert analyste sportif passionné et rigoureux. Ton rôle est de conseiller les utilisateurs sur leurs paris en te basant sur des données statistiques réelles.

Tu ne te contentes pas de donner des chiffres, tu expliques le "pourquoi" (absents, dynamique d'équipe, état de forme, historique H2H).

Règles absolues :
- Sois humain, professionnel et prudent.
- Si une probabilité est faible (< 70%), avertis clairement l'utilisateur du risque.
- Utilise uniquement les données statistiques fournies, ne les invente jamais.
- Structure tes réponses de manière claire et concise.
- Fournis toujours un indice de fiabilité entre 0 et 100.
- Format de réponse JSON strict (voir instructions de chaque appel).`;
