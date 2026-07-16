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
  recupererNomUtilisateur,
} from '../_shared/facebook.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const WEB_APP_URL     = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const REDIRECT_URI    = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

/** Envoie un message Telegram — jamais lancé d'exception, jamais bloquant. */
async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  if (!TELEGRAM_TOKEN || !chatId) {
    console.warn('[sendTelegram] TOKEN ou chatId manquant, message non envoyé');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[sendTelegram] Erreur HTTP', res.status, body);
    }
  } catch (err) {
    console.error('[sendTelegram] Exception réseau:', err);
  }
}

// Supabase force le Content-Type des réponses de Edge Functions à "text/plain"
// sur le domaine partagé functions.supabase.co (pas de support HTML natif hors
// domaine personnalisé) : servir du HTML inline ici corrompt les accents/emoji
// (mojibake) et le navigateur affiche le code source au lieu de la page.
// On redirige donc vers une page statique hébergée sur Vercel (Content-Type
// correct, garanti par Vercel) qui affiche le message à partir de l'URL.
function htmlPage(icon: string, titre: string, corps: string, close = false): Response {
  if (WEB_APP_URL) {
    const dest = `${WEB_APP_URL}/fb-status.html`
      + `?icon=${encodeURIComponent(icon)}`
      + `&titre=${encodeURIComponent(titre)}`
      + `&corps=${encodeURIComponent(corps)}`
      + (close ? '&action=close' : '');
    return new Response(null, { status: 302, headers: { Location: dest } });
  }
  // Filet de sécurité si WEB_APP_URL n'est pas configuré (ne devrait pas arriver en prod).
  return new Response(
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${titre}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;
        display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}
      .c{background:#1a1f2e;border:1px solid #2d3748;border-radius:16px;
        padding:40px;max-width:420px;width:100%;text-align:center}
      .i{font-size:52px;margin-bottom:16px}
      h2{color:#fff;font-size:22px;margin-bottom:12px}
      p{color:#a0aec0;line-height:1.7;font-size:15px}
    </style></head>
    <body><div class="c">
      <div class="i">${icon}</div>
      <h2>${titre}</h2>
      <p>${corps}</p>
    </div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

Deno.serve(async (req: Request) => {
  const url    = new URL(req.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');
  const erreur = url.searchParams.get('error');
  const init   = url.searchParams.get('init');

  console.log('[facebook-oauth] requête reçue — init:', init, 'code:', !!code, 'state:', !!state, 'error:', erreur ?? 'aucun');
  console.log('[facebook-oauth] REDIRECT_URI utilisé:', REDIRECT_URI);

  // ── Redirect initial : le bouton Telegram pointe ici (?init=1&nonce=...)
  //    On fait un 302 côté serveur vers Facebook pour contourner l'interception
  //    de l'app Facebook Lite sur Android (App Links ne se déclenchent pas sur
  //    les redirects HTTP du navigateur, seulement sur les clics directs).
  if (init === '1') {
    const nonce = url.searchParams.get('nonce') ?? '';
    if (!nonce) {
      return htmlPage('❌', 'Lien invalide', 'Paramètre nonce manquant. Retourne sur Telegram et réessaie.');
    }
    const fbUrl = `https://www.facebook.com/v22.0/dialog/oauth`
      + `?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&state=${encodeURIComponent(nonce)}`
      + `&scope=pages_manage_posts,pages_read_engagement,pages_show_list`
      + ``;
    console.log('[facebook-oauth] init redirect → Facebook:', fbUrl.substring(0, 80) + '…');
    return new Response(null, { status: 302, headers: { Location: fbUrl } });
  }

  // ── Cas d'erreur retournée par Facebook (app inactive, accès refusé, etc.) ──
  if (erreur || !code || !state) {
    const errorDescription = url.searchParams.get('error_description') ?? '';
    const errorReason      = url.searchParams.get('error_reason') ?? '';
    console.warn('[facebook-oauth] Erreur Facebook:', erreur, errorReason, errorDescription);

    if (erreur === 'application_inactive' || errorReason === 'application_inactive') {
      return htmlPage('🔧', 'Application en cours d\'activation',
        'Cette application Facebook est en cours de validation par Meta. Réessaie dans quelques minutes.');
    }
    if (erreur === 'access_denied') {
      return htmlPage('🚫', 'Accès refusé',
        'Tu as refusé l\'accès. Retourne sur Telegram et clique à nouveau sur "Connecter Facebook" si tu veux recommencer.');
    }
    if (!code || !state) {
      return htmlPage('❌', 'Lien invalide',
        'Paramètres manquants. Retourne sur Telegram et demande à nouveau à connecter ta Page Facebook.');
    }
    return htmlPage('❌', 'Connexion annulée', 'Retourne sur Telegram et réessaie.');
  }

  // ── Validation du nonce anti-CSRF ──────────────────────────────────────────
  let telegramUserId: number | null = null;
  try {
    telegramUserId = await validerNonce(state, supabase);
  } catch (nonceErr) {
    console.error('[facebook-oauth] Exception validerNonce:', nonceErr);
    return htmlPage('❌', 'Erreur interne',
      'Une erreur est survenue lors de la validation. Retourne sur Telegram et réessaie.');
  }

  if (!telegramUserId) {
    console.warn('[facebook-oauth] Nonce invalide ou expiré:', state.slice(0, 8) + '…');
    return htmlPage('⚠️', 'Lien expiré ou déjà utilisé',
      'Ce lien a déjà été utilisé ou a expiré (validité 10 min). Retourne sur Telegram et demande à nouveau à connecter ta Page Facebook.');
  }

  console.log('[facebook-oauth] Nonce OK — telegramUserId:', telegramUserId);

  // ── Échange du code OAuth + sauvegarde ────────────────────────────────────
  try {
    // 1. Échange code → token court
    console.log('[facebook-oauth] Échange du code…');
    const shortToken = await echangerCode(code, REDIRECT_URI);
    if (!shortToken) {
      console.error('[facebook-oauth] echangerCode a retourné null — App Secret incorrect ou code expiré');
      await sendTelegram(telegramUserId,
        '❌ *Erreur de connexion Facebook*\n\nImpossible d\'échanger le code d\'autorisation. Vérifie que l\'App Secret Facebook est correct dans les paramètres Supabase, puis réessaie.');
      return htmlPage('❌', 'Échange de code échoué',
        'L\'autorisation Facebook n\'a pas pu être finalisée. Causes possibles : App Secret incorrect, code expiré, ou URI de redirection non enregistrée dans Facebook App Settings. Retourne sur Telegram.');
    }
    console.log('[facebook-oauth] Token court obtenu');

    // 2. Token long (60 j) + FB User ID en parallèle
    console.log('[facebook-oauth] Prolongation du token…');
    const [longToken, fbUserId] = await Promise.all([
      prolongerToken(shortToken),
      recupererFbUserId(shortToken),
    ]);
    console.log('[facebook-oauth] Long token OK — fbUserId:', fbUserId);

    // 3. Pages Facebook de l'utilisateur
    console.log('[facebook-oauth] Récupération des Pages…');
    const pages = await recupererPages(longToken);
    console.log('[facebook-oauth] Pages trouvées:', pages.length);

    if (!pages.length) {
      await sendTelegram(telegramUserId,
        "❌ *Aucune Page Facebook trouvée*\n\nAssure-toi d'être *administrateur* d'au moins une Page Facebook, puis redemande à te connecter.");
      return htmlPage('📭', 'Aucune Page trouvée',
        "Assure-toi d'être administrateur d'au moins une Page Facebook, puis retourne sur Telegram et réessaie.");
    }

    // 4. Sauvegarde des Pages dans facebook_connections
    for (const page of pages) {
      const { error: upsertErr } = await supabase.from('facebook_connections').upsert({
        telegram_user_id:     telegramUserId,
        fb_user_id:           fbUserId,
        fb_user_name:         fbUserName || null,
        fb_page_id:           page.id,
        fb_page_name:         page.name,
        fb_page_access_token: page.access_token,
        is_active:            true,
      }, { onConflict: 'telegram_user_id,fb_page_id' });
      if (upsertErr) console.error('[facebook-oauth] Erreur upsert page', page.id, upsertErr);
    }
    console.log('[facebook-oauth] Pages sauvegardées');

    // 5. Profil utilisateur
    const { data: profil, error: profilErr } = await supabase
      .from('user_profiles')
      .upsert({ telegram_user_id: telegramUserId, onboarded: true }, { onConflict: 'telegram_user_id' })
      .select('web_access_token')
      .single();
    if (profilErr) console.error('[facebook-oauth] Erreur upsert profil:', profilErr);

    // 6. Notification Telegram de succès — ouvre la Mini App directement sur l'onglet Facebook
    const boutonMiniApp = WEB_APP_URL
      ? { inline_keyboard: [[{ text: '🌐 Ouvrir mon espace', web_app: { url: `${WEB_APP_URL}?tab=facebook` } }]] }
      : undefined;
    await sendTelegram(
      telegramUserId,
      `✅ *Facebook connecté* (${pages.map((p) => p.name).join(', ')}) !\n\nDernière étape : active la diffusion sur tes matchs en direct depuis l'onglet Facebook 👇`,
      boutonMiniApp,
    );

    console.log('[facebook-oauth] ✅ Connexion réussie pour', telegramUserId);
    return htmlPage('✅', 'Facebook connecté !',
      'Ta Page est connectée. Tu peux fermer cette page et retourner sur Telegram.', true);

  } catch (e) {
    console.error('[facebook-oauth] ❌ Exception non gérée:', e);
    // sendTelegram est lui-même blindé, il ne peut pas relancer une exception
    await sendTelegram(telegramUserId,
      '❌ Une erreur inattendue est survenue pendant la connexion Facebook. Retourne sur Telegram et redemande à te connecter.');
    return htmlPage('❌', 'Erreur inattendue',
      'Une erreur inattendue est survenue. Retourne sur Telegram et réessaie de te connecter.');
  }
});
