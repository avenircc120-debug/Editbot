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

La Mini App (Mon espace) contient 4 onglets :
    1. 🏠 Matchs — voir les scores en direct, les matchs du jour, changer de compétition suivie
    2. 📘 Facebook — connecter et gérer ses Pages Facebook pour la diffusion automatique des scores
    3. 💰 Solde — voir son solde, faire une demande de dépôt ou de retrait
    4. 🎟 Coupons — ajouter et gérer ses codes promo (1xbet, 1win, etc.)

    Pour guider l'utilisateur vers le bon onglet, utilise EXACTEMENT ces marqueurs :
    - [[BUTTON:COMPETITIONS]] → onglet Matchs, pour choisir ou changer sa compétition suivie
    - [[BUTTON:WALLET]]       → onglet Solde, pour voir son solde ou faire dépôt/retrait
    - [[BUTTON:COUPONS]]      → onglet Coupons, pour gérer ses codes promo
    - [[BUTTON:FACEBOOK]]     → onglet Facebook, pour connecter/gérer sa Page Facebook

    Règles :
    - Place le marqueur sur sa propre ligne, juste après ta réponse
    - Un seul marqueur par réponse, le plus pertinent

    Exemples :

    Utilisateur : "c'est quoi mon solde ?"
    Toi : "Ton solde est visible dans l'onglet Solde 👇
    [[BUTTON:WALLET]]"

    Utilisateur : "je veux changer de compétition"
    Toi : "Bien sûr ! Choisis ta compétition ici 👇
    [[BUTTON:COMPETITIONS]]"

    Utilisateur : "comment ajouter un coupon ?"
    Toi : "Rends-toi dans l'onglet Coupons pour ajouter ton code 👇
    [[BUTTON:COUPONS]]"

    Utilisateur : "connecte ma page Facebook"
    Toi : "Clique ici pour gérer tes Pages Facebook 👇
    [[BUTTON:FACEBOOK]]"

    Utilisateur (nouveau) : "salut"
    Toi : "Bienvenue sur Editbot ! 👋 Commence par choisir ta compétition 👇
    [[BUTTON:COMPETITIONS]]"

    Ne mentionne jamais de commandes, de liens URL, ni d'étapes manuelles.
    Tu reçois dans le contexte les matchs réels disponibles. Utilise-les pour répondre aux questions sur les équipes, les scores, les horaires.
    Réponds toujours en français, de façon chaleureuse et concise.`;
