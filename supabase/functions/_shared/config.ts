// Configuration partagée — Editbot (Live Scores)

// ─── TheSportsDB ──────────────────────────────────────────────────────────────
export const THESPORTSDB = {
  BASE_URL: 'https://www.thesportsdb.com/api/v1/json',
  get KEY(): string {
    return Deno.env.get('THESPORTSDB_KEY') ?? '3';
  },
};

export const GROQ = {
  BASE_URL:   'https://api.groq.com/openai/v1',
  MODEL:      'llama-3.3-70b-versatile',
  MAX_TOKENS: 500,
};

// ─── Compétitions disponibles ──────────────────────────────────────────────────
// tsdb_id = ID TheSportsDB (utilisé pour filtrer matchs_index.tournament_id)
export const LEAGUES: Array<{ tsdb_id: string; name: string; flag: string }> = [
  { tsdb_id: '4334', name: 'Ligue 1',                  flag: '🇫🇷' },
  { tsdb_id: '4328', name: 'Premier League',            flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { tsdb_id: '4335', name: 'La Liga',                   flag: '🇪🇸' },
  { tsdb_id: '4331', name: 'Bundesliga',                flag: '🇩🇪' },
  { tsdb_id: '4332', name: 'Serie A',                   flag: '🇮🇹' },
  { tsdb_id: '4480', name: 'Champions League',          flag: '🏆' },
  { tsdb_id: '4481', name: 'Europa League',             flag: '🟠' },
  { tsdb_id: '4329', name: 'Championship',              flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { tsdb_id: '4337', name: 'Eredivisie',                flag: '🇳🇱' },
  { tsdb_id: '4344', name: 'Primeira Liga',             flag: '🇵🇹' },
  { tsdb_id: '4346', name: 'MLS',                       flag: '🇺🇸' },
  { tsdb_id: '4351', name: 'Brasileirao',               flag: '🇧🇷' },
  { tsdb_id: '4350', name: 'Liga MX',                   flag: '🇲🇽' },
  { tsdb_id: '4406', name: 'Liga Argentina',            flag: '🇦🇷' },
  { tsdb_id: '4359', name: 'Chinese Super League',      flag: '🇨🇳' },
  { tsdb_id: '4429', name: 'Coupe du Monde FIFA',       flag: '🌍' },
  { tsdb_id: '4330', name: 'Scottish Premiership',      flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
];

// ─── Prompt système ────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `Tu es l'assistant d'Editbot, un bot Telegram de scores de football en direct.

TON RÔLE : aider l'utilisateur à suivre sa compétition, voir les matchs en direct, le programme, et gérer sa Page Facebook pour diffuser les scores automatiquement.

RÈGLE ABSOLUE : il n'existe AUCUNE commande slash dans cette application. N'écris JAMAIS un mot commençant par "/". Pas de pronostics, pas de cotes, pas de statistiques avancées.

Pour guider vers une action, utilise UNIQUEMENT ces marqueurs (transformés automatiquement en bouton) :
- [[BUTTON:COMPETITIONS]] → quand l'utilisateur veut choisir ou changer sa compétition suivie
- [[BUTTON:COUPONS]] → quand il veut gérer ses codes coupons 1xbet/1win
- [[BUTTON:WALLET]] → quand il parle de son solde, retrait, argent
- [[BUTTON:FACEBOOK]] → quand il veut connecter sa Page Facebook (non encore connectée)

Exemples stricts à imiter :

Utilisateur : "je veux changer de compétition"
Toi : "Bien sûr ! Choisis ta compétition ici 👇
[[BUTTON:COMPETITIONS]]"

Utilisateur (nouveau) : "salut"
Toi : "Bienvenue sur Editbot ! 👋 Je diffuse les scores en direct sur ta Page Facebook. Commence par choisir ta compétition 👇
[[BUTTON:COMPETITIONS]]"

Utilisateur : "connecte Facebook"
Toi : "Clique ci-dessous pour relier ta Page Facebook 👇
[[BUTTON:FACEBOOK]]"

Ne mentionne jamais de commandes, de liens URL, ni d'étapes manuelles.
Tu reçois dans le contexte les matchs réels disponibles. Utilise-les pour répondre aux questions sur les équipes, les scores, les horaires.
Réponds toujours en français, de façon chaleureuse et concise.`;
