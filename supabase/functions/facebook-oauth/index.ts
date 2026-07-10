/**
 * facebook-oauth — Callback OAuth Meta (Supabase Edge Function)
 * URL : <SUPABASE_URL>/functions/v1/facebook-oauth
 *
 * Flux :
 *   1. Meta redirige ici avec ?code=...&state=<nonce>
 *   2. Validation du nonce (anti-CSRF, usage unique, expiry)
 *   3. Échange code → long-lived token (60 jours)
 *   4. Récupération des Pages Facebook
 *   5. Sauvegarde dans facebook_connections + création du profil utilisateur
 *   6. Message Telegram avec le lien vers l'espace web (compétitions + coupons)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  validerNonce,
  echangerCode,
  prolongerToken,
  recupererPages,
  recupererFbUserId,
} from '../_shared/facebook.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const WEB_APP_URL    = Deno.env.get('WEB_APP_URL')                ?? '';
const REDIRECT_URI   = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
  });
}

function htmlPage(icon: string, titre: string, corps: string) {
  return new Response(
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${titre}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;
    display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}
    .c{background:#1a1f2e;border:1px solid #2d3748;border-radius:16px;
    padding:40px;max-width:420px;text-align:center}
    .i{font-size:52px;margin-bottom:16px}
    h2{color:#fff;font-size:22px;margin-bottom:12px}
    p{color:#a0aec0;line-height:1.7;font-size:15px}</style></head>
    <body><div class="c"><div class="i">${icon}</div>
    <h2>${titre}</h2><p>${corps}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

Deno.serve(async (req: Request) => {
  const url    = new URL(req.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');
  const erreur = url.searchParams.get('error');

  if (erreur || !code || !state) {
    return htmlPage('❌', 'Connexion annulée', 'Vous pouvez fermer cette page et retourner sur Telegram.');
  }

  const telegramUserId = await validerNonce(state, supabase);
  if (!telegramUserId) {
    return htmlPage('⚠️', 'Lien expiré ou invalide',
      'Ce lien a déjà été utilisé ou a expiré. Recommencez depuis Telegram avec /connect_facebook.');
  }

  try {
    const shortToken = await echangerCode(code, REDIRECT_URI);
    if (!shortToken) throw new Error('Échange de code échoué');

    const [longToken, fbUserId] = await Promise.all([
      prolongerToken(shortToken),
      recupererFbUserId(shortToken),
    ]);

    const pages = await recupererPages(longToken);

    if (!pages.length) {
      await sendTelegram(telegramUserId,
        "❌ Aucune Page Facebook trouvée. Assurez-vous d'être administrateur d'au moins une Page, puis relancez /connect_facebook.");
      return htmlPage('📭', 'Aucune Page trouvée',
        "Revenez sur Telegram. Assurez-vous d'administrer au moins une Page Facebook.");
    }

    for (const page of pages) {
      await supabase.from('facebook_connections').upsert({
        telegram_user_id:     telegramUserId,
        fb_user_id:           fbUserId,
        fb_page_id:           page.id,
        fb_page_name:         page.name,
        fb_page_access_token: page.access_token,
        is_active:            true,
      }, { onConflict: 'telegram_user_id,fb_page_id' });
    }

    // Crée/assure le profil utilisateur et récupère son jeton d'accès à l'espace web.
    const { data: profil } = await supabase
      .from('user_profiles')
      .upsert({ telegram_user_id: telegramUserId, onboarded: true }, { onConflict: 'telegram_user_id' })
      .select('web_access_token')
      .single();

    const lienEspace = `${WEB_APP_URL}?token=${profil?.web_access_token ?? ''}`;

    await sendTelegram(
      telegramUserId,
      `✅ *Facebook connecté* (${pages.map((p) => p.name).join(', ')}) !

Dernière étape : choisis les compétitions à diffuser sur ta Page et dépose tes codes coupons (1xbet / 1win) dans ton espace 👇`,
      { inline_keyboard: [[{ text: '🌐 Ouvrir mon espace', url: lienEspace }]] },
    );

    return htmlPage('✅', 'Facebook connecté !', 'Retourne sur Telegram pour configurer tes compétitions et tes coupons.');
  } catch (e) {
    console.error('[facebook-oauth]', e);
    await sendTelegram(telegramUserId, "❌ Une erreur est survenue pendant la connexion Facebook. Réessaie avec /connect_facebook.");
    return htmlPage('❌', 'Erreur', "Une erreur est survenue. Retourne sur Telegram et réessaie avec /connect_facebook.");
  }
});
