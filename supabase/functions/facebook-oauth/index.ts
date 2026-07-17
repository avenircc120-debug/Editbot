/**
 * facebook-oauth — Callback OAuth Meta (Supabase Edge Function)
 *
 * Flux redirect (conservé) :
 *   GET  ?init=1&nonce=…   → redirige vers fb-connect.html avec appId + nonce + api (SDK)
 *   GET  ?code=…&state=…   → callback OAuth Facebook classique
 *
 * Flux SDK JS Facebook (nouveau) :
 *   POST body:{token,nonce} → token du SDK, valide nonce, sauvegarde Pages, notifie Telegram
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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
    if (!res.ok) console.error('[sendTelegram] HTTP', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[sendTelegram] Exception:', err);
  }
}

function htmlPage(icon: string, titre: string, corps: string, close = false, extra = ''): Response {
  if (WEB_APP_URL) {
    const dest = `${WEB_APP_URL}/fb-status.html`
      + `?icon=${encodeURIComponent(icon)}`
      + `&titre=${encodeURIComponent(titre)}`
      + `&corps=${encodeURIComponent(corps)}`
      + (close ? '&action=close' : '')
      + extra;
    return new Response(null, { status: 302, headers: { Location: dest } });
  }
  return new Response(
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}.c{background:#1a1f2e;border:1px solid #2d3748;border-radius:16px;padding:40px;max-width:420px;width:100%;text-align:center}.i{font-size:52px;margin-bottom:16px}h2{color:#fff;font-size:22px;margin-bottom:12px}p{color:#a0aec0;line-height:1.7;font-size:15px}</style>
    </head><body><div class="c"><div class="i">${icon}</div><h2>${titre}</h2><p>${corps}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/** Prolonge token, récupère pages, sauvegarde en base, notifie Telegram. */
async function traiterToken(
  shortToken: string,
  telegramUserId: number,
): Promise<{ ok: boolean; pageNames: string[]; addNonce?: string }> {
  const [longToken, fbUserId, fbUserName] = await Promise.all([
    prolongerToken(shortToken),
    recupererFbUserId(shortToken),
    recupererNomUtilisateur(shortToken),
  ]);

  const pages = await recupererPages(longToken);
  console.log('[facebook-oauth] Pages trouvées:', pages.length);
  if (!pages.length) return { ok: false, pageNames: [] };

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

  await supabase.from('user_profiles').upsert(
    { telegram_user_id: telegramUserId, onboarded: true },
    { onConflict: 'telegram_user_id' },
  );

  const boutonMiniApp = WEB_APP_URL
    ? { inline_keyboard: [[{ text: '🌐 Ouvrir mon espace', web_app: { url: `${WEB_APP_URL}?tab=facebook` } }]] }
    : undefined;
  await sendTelegram(
    telegramUserId,
    `✅ *Facebook connecté* (${pages.map((p) => p.name).join(', ')}) !\n\nDernière étape : active la diffusion sur tes matchs en direct depuis l'onglet Facebook 👇`,
    boutonMiniApp,
  );

  let addNonce: string | undefined;
  try {
    const newNonce = crypto.randomUUID();
    const { error } = await supabase.from('facebook_oauth_states').insert({
      nonce:            newNonce,
      telegram_user_id: telegramUserId,
      expires_at:       new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    if (!error) addNonce = newNonce;
  } catch (e) {
    console.warn('[facebook-oauth] Exception nonce ajout:', e);
  }

  return { ok: true, pageNames: pages.map((p) => p.name), addNonce };
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // ── POST : flux SDK JS Facebook ────────────────────────────────────────────
  // fb-connect.html appelle FB.login() puis POSTe ici {token, nonce} via fetch.
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      const { token: shortToken, nonce } = body as { token?: string; nonce?: string };
      if (!shortToken || !nonce) return jsonRes({ error: 'token et nonce requis' }, 400);

      console.log('[facebook-oauth/sdk] nonce:', nonce.slice(0, 8) + '…');
      const telegramUserId = await validerNonce(nonce, supabase);
      if (!telegramUserId) {
        return jsonRes({ error: 'Lien expiré ou déjà utilisé. Retourne sur Telegram et réessaie.' }, 400);
      }

      const result = await traiterToken(shortToken, telegramUserId);
      if (!result.ok) {
        await sendTelegram(telegramUserId,
          "❌ *Aucune Page Facebook trouvée*\n\nAssure-toi d'être *administrateur* d'au moins une Page Facebook, puis redemande à te connecter.");
        return jsonRes({ error: "Aucune Page Facebook trouvée. Assure-toi d'être administrateur d'au moins une Page." }, 400);
      }

      const addUrl = result.addNonce
        ? `${SUPABASE_URL}/functions/v1/facebook-oauth?init=1&nonce=${encodeURIComponent(result.addNonce)}&add=1`
        : undefined;

      console.log('[facebook-oauth/sdk] ✅ réussi pour', telegramUserId);
      return jsonRes({ ok: true, pages: result.pageNames, addUrl });
    } catch (e) {
      console.error('[facebook-oauth/sdk] Exception:', e);
      return jsonRes({ error: 'Erreur interne' }, 500);
    }
  }

  // ── GET : flux redirect + callback OAuth ───────────────────────────────────
  const url    = new URL(req.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');
  const erreur = url.searchParams.get('error');
  const init   = url.searchParams.get('init');

  console.log('[facebook-oauth] init:', init, 'code:', !!code, 'state:', !!state, 'error:', erreur ?? 'aucun');
  console.log('[facebook-oauth] REDIRECT_URI:', REDIRECT_URI);

  // ?init=1 → redirige vers fb-connect.html avec SDK params (appId + nonce + api)
  if (init === '1') {
    const nonce = url.searchParams.get('nonce') ?? '';
    const add   = url.searchParams.get('add') === '1';
    if (!nonce) return htmlPage('❌', 'Lien invalide', 'Paramètre nonce manquant. Retourne sur Telegram et réessaie.');

    // Nouveau flux SDK : fb-connect.html initialise le SDK FB et appelle FB.login()
    const connectPage = WEB_APP_URL
      ? `${WEB_APP_URL}/fb-connect.html`
          + `?appId=${encodeURIComponent(FACEBOOK_APP_ID)}`
          + `&nonce=${encodeURIComponent(nonce)}`
          + `&api=${encodeURIComponent(SUPABASE_URL)}`
          + (add ? '&add=1' : '')
      // Fallback si WEB_APP_URL absent : ancien flux redirect Facebook OAuth
      : `https://www.facebook.com/v22.0/dialog/oauth`
          + `?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}`
          + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
          + `&state=${encodeURIComponent(nonce)}`
          + '&scope=pages_manage_posts,pages_read_engagement,pages_show_list';

    console.log('[facebook-oauth] init→fb-connect SDK, add=', add);
    return new Response(null, { status: 302, headers: { Location: connectPage } });
  }

  // Erreurs retournées par Facebook
  if (erreur || !code || !state) {
    const errorReason = url.searchParams.get('error_reason') ?? '';
    console.warn('[facebook-oauth] Erreur Facebook:', erreur, errorReason);
    if (erreur === 'application_inactive' || errorReason === 'application_inactive')
      return htmlPage('🔧', "Application en cours d'activation", 'Cette application Facebook est en cours de validation par Meta. Réessaie dans quelques minutes.');
    if (erreur === 'access_denied')
      return htmlPage('🚫', 'Accès refusé', "Tu as refusé l'accès. Retourne sur Telegram et clique à nouveau sur «Connecter Facebook» si tu veux recommencer.");
    if (!code || !state)
      return htmlPage('❌', 'Lien invalide', 'Paramètres manquants. Retourne sur Telegram et demande à nouveau à connecter ta Page Facebook.');
    return htmlPage('❌', 'Connexion annulée', 'Retourne sur Telegram et réessaie.');
  }

  // Callback OAuth classique (?code=…&state=<nonce>)
  let telegramUserId: number | null = null;
  try {
    telegramUserId = await validerNonce(state, supabase);
  } catch (nonceErr) {
    console.error('[facebook-oauth] validerNonce exception:', nonceErr);
    return htmlPage('❌', 'Erreur interne', 'Une erreur est survenue lors de la validation. Retourne sur Telegram et réessaie.');
  }

  if (!telegramUserId) {
    return htmlPage('⚠️', 'Lien expiré ou déjà utilisé',
      'Ce lien a déjà été utilisé ou a expiré (validité 10 min). Retourne sur Telegram et demande à nouveau à connecter ta Page Facebook.');
  }

  try {
    const shortToken = await echangerCode(code, REDIRECT_URI);
    if (!shortToken) {
      await sendTelegram(telegramUserId,
        "❌ *Erreur de connexion Facebook*\n\nImpossible d'échanger le code d'autorisation. Vérifie que l'App Secret Facebook est correct dans les paramètres Supabase, puis réessaie.");
      return htmlPage('❌', 'Échange de code échoué',
        "L'autorisation Facebook n'a pas pu être finalisée. Causes possibles : App Secret incorrect, code expiré, ou URI de redirection non enregistrée. Retourne sur Telegram.");
    }

    const result = await traiterToken(shortToken, telegramUserId);
    if (!result.ok) {
      await sendTelegram(telegramUserId,
        "❌ *Aucune Page Facebook trouvée*\n\nAssure-toi d'être *administrateur* d'au moins une Page Facebook, puis redemande à te connecter.");
      return htmlPage('📭', 'Aucune Page trouvée',
        "Assure-toi d'être administrateur d'au moins une Page Facebook, puis retourne sur Telegram et réessaie.");
    }

    let addParam = '';
    if (result.addNonce) {
      const addUrl = `${SUPABASE_URL}/functions/v1/facebook-oauth?init=1&nonce=${encodeURIComponent(result.addNonce)}&add=1`;
      addParam = `&addUrl=${encodeURIComponent(addUrl)}`;
    }

    console.log('[facebook-oauth] ✅ réussi pour', telegramUserId);
    return htmlPage('✅', 'Facebook connecté !',
      'Ta Page est connectée. Tu peux fermer cette page et retourner sur Telegram.', true, addParam);

  } catch (e) {
    console.error('[facebook-oauth] ❌ Exception:', e);
    await sendTelegram(telegramUserId,
      '❌ Une erreur inattendue est survenue pendant la connexion Facebook. Retourne sur Telegram et redemande à te connecter.');
    return htmlPage('❌', 'Erreur inattendue',
      'Une erreur inattendue est survenue. Retourne sur Telegram et réessaie de te connecter.');
  }
});
