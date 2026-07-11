/**
 * telegram-webhook — Editbot
 *
 * 100% conversationnel : aucune commande à taper. L'utilisateur écrit
 * librement, l'assistant GROQ comprend l'intention et répond. Quatre actions
 * bien distinctes peuvent être proposées, chacune avec son propre bouton,
 * toutes ouvrant la même mini-app à onglets (app.html) sauf Facebook :
 *   - Compétitions (choisir les ligues suivies)   → app.html?tab=competitions (Web App)
 *   - Coupons (codes 1xbet / 1win)                → app.html?tab=coupons (Web App)
 *   - Wallet (dépôt / retrait / historique)       → app.html?tab=wallet (Web App)
 *   - Connexion Facebook                          → ouvre un lien externe (obligatoire :
 *     Meta bloque l'OAuth dans les navigateurs embarqués/WebView, donc ce bouton ne
 *     peut pas être une Web App Telegram — c'est une contrainte de Facebook, pas un choix).
 *
 * Double garde-fou (le modèle GROQ hallucine parfois des commandes /xxx
 * malgré le prompt) :
 *  1. Détection déterministe de l'intention à partir du message utilisateur
 *     (mots-clés), en plus des marqueurs [[BUTTON:...]] émis par le modèle.
 *  2. Nettoyage systématique (au niveau phrase) de toute mention de commande
 *     slash ou du mot "commande"/"taper" dans le texte final avant envoi.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const WEB_APP_URL     = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const REDIRECT_URI    = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

const RE_COMPETITION = /(compétition|compétitions|ligue|ligues|championnat)/i;
const RE_COUPON      = /(coupon|coupons|1xbet|1win|code promo|bookmaker)/i;
const RE_WALLET       = /(wallet|portefeuille|solde|dépôt|depot|retrait|retirer|argent|gains?)/i;
const RE_FACEBOOK     = /facebook/i;
const RE_SLASH        = /`?\/[a-zA-Z_]+`?/g;

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
  });
}

/** Récupère (ou crée) le profil de l'utilisateur et indique s'il est nouveau. */
async function assurerProfil(chatId: number): Promise<{ token: string; nouveau: boolean }> {
  const { data: existant } = await supabase
    .from('user_profiles')
    .select('web_access_token')
    .eq('telegram_user_id', chatId)
    .maybeSingle();

  if (existant) return { token: existant.web_access_token ?? '', nouveau: false };

  const { data: cree } = await supabase
    .from('user_profiles')
    .insert({ telegram_user_id: chatId })
    .select('web_access_token')
    .single();

  return { token: cree?.web_access_token ?? '', nouveau: true };
}

/** Construit un contexte matchs riche : aujourd'hui, à venir (7 jours), et résultats récents (48h). */
async function contexteMatchs(): Promise<string> {
  const maintenant = new Date();
  const debutHier = new Date(maintenant.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const finSemaine = new Date(maintenant.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('matchs_index')
    .select('competition, home_team, away_team, match_date, status, home_score, away_score')
    .gte('match_date', debutHier)
    .lte('match_date', finSemaine)
    .order('match_date', { ascending: true })
    .limit(120);

  if (!data?.length) return "Aucun match trouvé dans les prochains jours ni dans les 48 dernières heures, pour les compétitions suivies.";

  const ligne = (m: typeof data[number]) => {
    const date = new Date(m.match_date);
    const jourHeure = date.toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const score = m.home_score !== null && m.away_score !== null ? ` — score ${m.home_score}-${m.away_score} (${m.status})` : ` — ${jourHeure} UTC (${m.status})`;
    return `- [${m.competition}] ${m.home_team} vs ${m.away_team}${score}`;
  };

  const termines = data.filter((m) => m.status === 'finished' || m.status === 'match finished' || (m.home_score !== null && new Date(m.match_date) < maintenant));
  const aVenir   = data.filter((m) => !termines.includes(m));

  const sections: string[] = [];
  if (termines.length) sections.push('Résultats récents (48 dernières heures) :\n' + termines.map(ligne).join('\n'));
  if (aVenir.length)   sections.push('Matchs à venir (7 prochains jours, y compris aujourd\'hui) :\n' + aVenir.map(ligne).join('\n'));

  return sections.join('\n\n');
}

/** Génère un lien OAuth Facebook sécurisé (nonce anti-CSRF à usage unique, valable 10 min). */
async function genererLienFacebook(chatId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await supabase.from('facebook_oauth_states').insert({
    nonce,
    telegram_user_id: chatId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  return `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FACEBOOK_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${nonce}&scope=pages_manage_posts,pages_read_engagement,pages_show_list`;
}

/** Retire toute phrase mentionnant une commande slash hallucinée (nettoyage au niveau phrase,
 *  pour ne jamais laisser un fragment cassé comme "il suffit de taper . Cela te permettra..."). */
function nettoyer(texte: string): string {
  const segments = texte.split(/(?<=[.!?])\s+|\n+/);
  const gardees = segments.filter((seg) =>
    !RE_SLASH.test(seg) && !/\bcommandes?\b/i.test(seg) && !/\btaper\b/i.test(seg)
  );
  return gardees.join(' ').replace(/\s{2,}/g, ' ').trim();
}

async function repondreConversation(chatId: number, texte: string, token: string, nouveau: boolean) {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const brut = session?.history;
  const historique: ChatMessage[] = Array.isArray(brut) ? (brut as ChatMessage[]) : [];

  historique.push({ role: 'user', content: texte });

  const [matchs, { data: connexions }] = await Promise.all([
    contexteMatchs(),
    supabase.from('facebook_connections').select('id').eq('telegram_user_id', chatId).eq('is_active', true).limit(1),
  ]);
  const facebookConnecte = (connexions?.length ?? 0) > 0;

  const contexte = `${matchs}

Statut utilisateur : ${nouveau ? "nouvel utilisateur, jamais accueilli jusqu'ici" : 'utilisateur déjà connu, ne pas ré-accueillir'}.
Connexion Facebook : ${facebookConnecte ? 'déjà connectée' : 'non connectée'}.`;

  let reponse = await chatAssistant(historique.slice(-10), contexte);

  // Détection déterministe de l'intention (garde-fou en plus des marqueurs du modèle) —
  // quatre boutons bien séparés, jamais fusionnés.
  const veutFacebook     = reponse.includes('[[BUTTON:FACEBOOK]]')     || (RE_FACEBOOK.test(texte) && !facebookConnecte);
  const veutCompetitions = reponse.includes('[[BUTTON:COMPETITIONS]]') || RE_COMPETITION.test(texte);
  const veutCoupons      = reponse.includes('[[BUTTON:COUPONS]]')      || RE_COUPON.test(texte);
  const veutWallet       = reponse.includes('[[BUTTON:WALLET]]')       || RE_WALLET.test(texte);

  reponse = reponse
    .replace('[[BUTTON:FACEBOOK]]', '')
    .replace('[[BUTTON:COMPETITIONS]]', '')
    .replace('[[BUTTON:COUPONS]]', '')
    .replace('[[BUTTON:WALLET]]', '');
  reponse = nettoyer(reponse);

  // Chaque bouton sur sa propre ligne, jamais mélangés dans un seul lien.
  // Compétitions, coupons et wallet sont trois onglets d'une même mini-app (app.html).
  const rangees: Array<Array<{ text: string; url?: string; web_app?: { url: string } }>> = [];
  if (veutCompetitions) rangees.push([{ text: '🏆 Mes compétitions', web_app: { url: `${WEB_APP_URL}/app.html?tab=competitions&token=${token}` } }]);
  if (veutCoupons)      rangees.push([{ text: '🎟️ Mes coupons', web_app: { url: `${WEB_APP_URL}/app.html?tab=coupons&token=${token}` } }]);
  if (veutWallet)       rangees.push([{ text: '💰 Mon wallet', web_app: { url: `${WEB_APP_URL}/app.html?tab=wallet&token=${token}` } }]);
  if (veutFacebook) {
    const lien = await genererLienFacebook(chatId);
    // Bouton "url" classique (pas Web App) : Facebook refuse l'authentification dans un
    // navigateur embarqué/WebView, ce lien doit s'ouvrir dans le navigateur externe.
    rangees.push([{ text: '🔗 Connecter Facebook', url: lien }]);
  }
  const boutons = rangees.length ? { inline_keyboard: rangees } : undefined;

  historique.push({ role: 'assistant', content: reponse });

  await supabase.from('bot_sessions').upsert({
    chat_id: chatId,
    history: historique.slice(-20),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });

  await sendTelegram(chatId, reponse, boutons);
}

Deno.serve(async (req: Request) => {
  const update = await req.json().catch(() => null);
  if (!update) return new Response('ok');

  const message = update.message;
  if (!message?.chat?.id) return new Response('ok');

  const chatId = message.chat.id as number;
  const texte: string = (message.text ?? '').trim();
  if (!texte) return new Response('ok');

  const { token, nouveau } = await assurerProfil(chatId);
  await repondreConversation(chatId, texte, token, nouveau);

  return new Response('ok');
});
