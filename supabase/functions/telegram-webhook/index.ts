/**
 * telegram-webhook — Editbot
 *
 * Parcours :
 *  - /start        → accueil + création du profil utilisateur
 *  - /dashboard     → boutons vers l'espace web (compétitions + coupons) et connexion Facebook
 *  - /connect_facebook → génère le lien OAuth Meta sécurisé (nonce anti-CSRF)
 *  - /aide          → aide
 *  - tout le reste  → conversation libre via l'assistant GROQ, contexte = matchs du jour réels
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';
import { messageBienvenue, messageAide } from '../_shared/templates.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const WEB_APP_URL     = Deno.env.get('WEB_APP_URL')                ?? '';
const REDIRECT_URI    = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
  });
}

async function assurerProfil(chatId: number): Promise<string> {
  const { data } = await supabase
    .from('user_profiles')
    .upsert({ telegram_user_id: chatId }, { onConflict: 'telegram_user_id', ignoreDuplicates: true })
    .select('web_access_token')
    .maybeSingle();

  if (data?.web_access_token) return data.web_access_token;

  const { data: existant } = await supabase.from('user_profiles').select('web_access_token').eq('telegram_user_id', chatId).single();
  return existant?.web_access_token ?? '';
}

async function matchsDuJourTexte(): Promise<string> {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('matchs_index')
    .select('competition, home_team, away_team, match_date, status, home_score, away_score')
    .gte('match_date', `${aujourdhui}T00:00:00Z`)
    .lte('match_date', `${aujourdhui}T23:59:59Z`)
    .order('match_date', { ascending: true })
    .limit(40);

  if (!data?.length) return "Aucun match programmé aujourd'hui dans les compétitions suivies.";

  return data.map((m) => {
    const heure = new Date(m.match_date).toISOString().slice(11, 16);
    const score = m.home_score !== null && m.away_score !== null ? ` (${m.home_score}-${m.away_score}, ${m.status})` : ` (${heure} UTC, ${m.status})`;
    return `- [${m.competition}] ${m.home_team} vs ${m.away_team}${score}`;
  }).join('\n');
}

async function repondreConversation(chatId: number, texte: string) {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const historique: ChatMessage[] = (session?.history as ChatMessage[]) ?? [];

  historique.push({ role: 'user', content: texte });
  const contexte = await matchsDuJourTexte();
  const reponse = await chatAssistant(historique.slice(-10), contexte);
  historique.push({ role: 'assistant', content: reponse });

  await supabase.from('bot_sessions').upsert({
    chat_id: chatId,
    history: historique.slice(-20),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });

  await sendTelegram(chatId, reponse);
}

async function envoyerDashboard(chatId: number) {
  const token = await assurerProfil(chatId);
  const lienEspace = `${WEB_APP_URL}?token=${token}`;

  const { data: connexions } = await supabase.from('facebook_connections').select('id').eq('telegram_user_id', chatId).eq('is_active', true).limit(1);
  const facebookConnecte = (connexions?.length ?? 0) > 0;

  const boutons = [[{ text: '🌐 Mon espace (compétitions & coupons)', url: lienEspace }]];
  if (!facebookConnecte) boutons.push([{ text: '🔗 Connecter Facebook', callback_data: 'connect_facebook' }]);

  await sendTelegram(chatId,
    `📊 *Ton dashboard Editbot*

Facebook : ${facebookConnecte ? '✅ connecté' : '❌ non connecté'}

Clique sur un bouton ci-dessous 👇`,
    { inline_keyboard: boutons },
  );
}

async function envoyerLienFacebook(chatId: number) {
  const nonce = crypto.randomUUID();
  await supabase.from('facebook_oauth_states').insert({
    nonce,
    telegram_user_id: chatId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  const lien = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FACEBOOK_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${nonce}&scope=pages_manage_posts,pages_read_engagement,pages_show_list`;

  await sendTelegram(chatId, "🔗 Connecte ta Page Facebook via ce lien sécurisé (valable 10 minutes) :", {
    inline_keyboard: [[{ text: '🔗 Connecter Facebook', url: lien }]],
  });
}

Deno.serve(async (req: Request) => {
  const update = await req.json().catch(() => null);
  if (!update) return new Response('ok');

  const message = update.message;
  const callback = update.callback_query;

  if (callback?.data === 'connect_facebook' && callback.message?.chat?.id) {
    await envoyerLienFacebook(callback.message.chat.id);
    return new Response('ok');
  }

  if (!message?.chat?.id) return new Response('ok');
  const chatId = message.chat.id as number;
  const texte: string = (message.text ?? '').trim();

  await assurerProfil(chatId);

  if (texte === '/start') {
    await sendTelegram(chatId, messageBienvenue());
  } else if (texte === '/dashboard') {
    await envoyerDashboard(chatId);
  } else if (texte === '/connect_facebook') {
    await envoyerLienFacebook(chatId);
  } else if (texte === '/aide' || texte === '/help') {
    await sendTelegram(chatId, messageAide());
  } else if (texte) {
    await repondreConversation(chatId, texte);
  }

  return new Response('ok');
});
