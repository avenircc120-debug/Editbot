/**
 * telegram-webhook — Editbot
 *
 * 100% conversationnel : aucune commande à taper. L'utilisateur écrit
 * librement, l'assistant GROQ comprend l'intention et répond. Quand l'accès
 * à l'espace web (compétitions/coupons) ou la connexion Facebook est
 * pertinente, l'assistant termine sa réponse par un marqueur invisible
 * ([[BUTTON:ESPACE]] ou [[BUTTON:FACEBOOK]]) que ce fichier transforme en
 * bouton cliquable Telegram — jamais de lien ou de commande écrite en clair.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';

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

async function repondreConversation(chatId: number, texte: string, token: string, nouveau: boolean) {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const brut = session?.history;
  const historique: ChatMessage[] = Array.isArray(brut) ? (brut as ChatMessage[]) : [];

  historique.push({ role: 'user', content: texte });

  const [matchs, { data: connexions }] = await Promise.all([
    matchsDuJourTexte(),
    supabase.from('facebook_connections').select('id').eq('telegram_user_id', chatId).eq('is_active', true).limit(1),
  ]);
  const facebookConnecte = (connexions?.length ?? 0) > 0;

  const contexte = `${matchs}

Statut utilisateur : ${nouveau ? "nouvel utilisateur, jamais accueilli jusqu'ici" : 'utilisateur déjà connu, ne pas ré-accueillir'}.
Connexion Facebook : ${facebookConnecte ? 'déjà connectée' : 'non connectée'}.`;

  let reponse = await chatAssistant(historique.slice(-10), contexte);
  let boutons: unknown;

  if (reponse.includes('[[BUTTON:FACEBOOK]]')) {
    reponse = reponse.replace('[[BUTTON:FACEBOOK]]', '').trim();
    if (!facebookConnecte) {
      const lien = await genererLienFacebook(chatId);
      boutons = { inline_keyboard: [[{ text: '🔗 Connecter Facebook', url: lien }]] };
    }
  } else if (reponse.includes('[[BUTTON:ESPACE]]')) {
    reponse = reponse.replace('[[BUTTON:ESPACE]]', '').trim();
    boutons = { inline_keyboard: [[{ text: '🌐 Mon espace (compétitions & coupons)', url: `${WEB_APP_URL}?token=${token}` }]] };
  }

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
