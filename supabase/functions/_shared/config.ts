// Configuration partagée : ligues suivies, modèle Groq, prompt système de l'assistant conversationnel.

export const GROQ = {
  BASE_URL:   'https://api.groq.com/openai/v1',
  MODEL:      'llama-3.3-70b-versatile',
  MAX_TOKENS: 700,
};

// ─── Compétitions suivies ──────────────────────────────────────────────────
// tsdb_id : ID TheSportsDB (utilisé par fetch-matches pour l'ingestion des scores)
export const LEAGUES: Array<{ tsdb_id: string; name: string }> = [
  { tsdb_id: '4334', name: 'Ligue 1' },
  { tsdb_id: '4328', name: 'Premier League' },
  { tsdb_id: '4335', name: 'La Liga' },
  { tsdb_id: '4331', name: 'Bundesliga' },
  { tsdb_id: '4332', name: 'Serie A' },
  { tsdb_id: '4480', name: 'Champions League' },
  { tsdb_id: '4481', name: 'Europa League' },
  { tsdb_id: '4329', name: 'Championship' },
  { tsdb_id: '4330', name: 'Scottish Premiership' },
  { tsdb_id: '4337', name: 'Eredivisie' },
  { tsdb_id: '4344', name: 'Primeira Liga' },
  { tsdb_id: '4346', name: 'MLS' },
  { tsdb_id: '4351', name: 'Brasileirão' },
  { tsdb_id: '4429', name: 'Coupe du Monde FIFA' },
  { tsdb_id: '4350', name: 'Liga MX' },
  { tsdb_id: '4406', name: 'Primera División Argentine' },
  { tsdb_id: '4359', name: 'Chinese Super League' },
];

// ─── Prompt système de l'assistant conversationnel (GROQ) ─────────────────
// L'assistant n'émet plus aucune prédiction / pronostic / cote conseillée.
// Il guide l'utilisateur (onboarding) et débriefe humainement les matchs du jour.
export const SYSTEM_PROMPT = `Tu es l'assistant conversationnel d'Editbot, un guide chaleureux et compétent pour les passionnés de football sur Telegram.

Ton rôle :
- Pour les nouveaux utilisateurs : accueille-les avec bienveillance, explique en quelques phrases simples comment fonctionne l'application (connecter Facebook via /connect_facebook, ouvrir son espace via /dashboard pour choisir ses compétitions et déposer ses codes coupons).
- Pour toute question sur les matchs du jour : tu reçois dans le contexte la liste réelle des matchs (avant, en cours, terminés). Utilise uniquement ces données réelles pour informer l'utilisateur — jamais de données inventées.
- Si des matchs sont terminés, débriefe humainement les scores et le déroulé, comme un ami passionné qui a suivi le match.
- Tu ne donnes JAMAIS de pronostic, de cote, de probabilité de résultat ou de conseil de pari. Ce n'est plus le rôle de l'application.
- Réponds toujours en français, de façon claire, chaleureuse et concise.`;
