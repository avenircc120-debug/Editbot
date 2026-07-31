/**
 * facebook-web-login — Connexion Facebook pour le portail web (sans Telegram)
 *
 * GET  ?init=1   → génère un nonce, redirige vers fb-connect-web.html
 * POST {token, nonce} → valide nonce, échange token FB, retourne web_access_token
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { prolongerToken, recupererFbUserId, recupererPages } from '../_shared/facebook.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const WEB_APP_URL     = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * Valide un nonce web (telegram_user_id = 0, réservé aux accès web).
 * Supprime le nonce après usage (usage unique).
 */
async function validerNonceWeb(nonce: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('facebook_oauth_states')
    .select('expires_at')
    .eq('nonce', nonce)
    .eq('telegram_user_id', 0)
    .maybeSingle();

  if (error) {
    console.error('[facebook-web-login] validerNonceWeb erreur:', error);
    return false;
  }
  if (!data) {
    console.warn('[facebook-web-login] Nonce introuvable');
    return false;
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    console.warn('[facebook-web-login] Nonce expiré');
    await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
    return false;
  }

  // Usage unique : supprimer immédiatement
  await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(req.url);

  // ── GET ?init=1 → crée nonce + redirige vers fb-connect-web.html ─────────
  if (req.method === 'GET') {
    const init = url.searchParams.get('init');
    if (init !== '1') {
      return json({ error: 'Paramètre init manquant.' }, 400);
    }
    if (!WEB_APP_URL) {
      console.error('[facebook-web-login] WEB_APP_URL non configuré');
      return json({ error: 'Configuration serveur incomplète.' }, 500);
    }
    if (!FACEBOOK_APP_ID) {
      console.error('[facebook-web-login] FACEBOOK_APP_ID non configuré');
      return json({ error: 'Configuration Facebook incomplète.' }, 500);
    }

    // telegram_user_id = 0 : valeur réservée pour les sessions web (hors Telegram)
    const nonce     = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertErr } = await supabase
      .from('facebook_oauth_states')
      .insert({ nonce, telegram_user_id: 0, expires_at: expiresAt });

    if (insertErr) {
      console.error('[facebook-web-login] Erreur création nonce:', insertErr);
      return json({ error: 'Erreur interne. Réessaie.' }, 500);
    }

    const dest = `${WEB_APP_URL}/fb-connect-web.html`
      + `?appId=${encodeURIComponent(FACEBOOK_APP_ID)}`
      + `&nonce=${encodeURIComponent(nonce)}`
      + `&api=${encodeURIComponent(SUPABASE_URL)}`;

    console.log('[facebook-web-login] init→fb-connect-web, nonce créé');
    return new Response(null, { status: 302, headers: { Location: dest } });
  }

  // ── POST {token, nonce} → échange token, retourne web_access_token ────────
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({})) as { token?: string; nonce?: string };
      const { token: shortToken, nonce } = body;

      if (!shortToken || !nonce) {
        return json({ error: 'token et nonce requis.' }, 400);
      }

      // Valider le nonce web
      const valid = await validerNonceWeb(nonce);
      if (!valid) {
        return json({ error: 'Lien expiré ou déjà utilisé. Retourne sur la page de connexion et réessaie.' }, 400);
      }

      // Échanger le token et récupérer l'identité Facebook
      const [longToken, fbUserId] = await Promise.all([
        prolongerToken(shortToken),
        recupererFbUserId(shortToken),
      ]);

      if (!fbUserId) {
        return json({ error: "Impossible d'identifier votre compte Facebook. Réessaie." }, 400);
      }

      const pages = await recupererPages(longToken);
      if (!pages.length) {
        return json({ error: "Aucune Page Facebook trouvée. Assure-toi d'être administrateur d'au moins une Page." }, 400);
      }

      // Retrouver le compte Editbot via les connexions Facebook existantes
      const { data: existing } = await supabase
        .from('facebook_connections')
        .select('telegram_user_id')
        .eq('fb_user_id', fbUserId)
        .limit(1)
        .maybeSingle();

      if (!existing) {
        return json({
          error: "Aucun compte Editbot trouvé pour ce compte Facebook. Connecte-toi d'abord via le bot Telegram, puis reviens ici.",
        }, 404);
      }

      const telegramUserId = existing.telegram_user_id;

      // Mettre à jour les tokens de Pages Facebook
      for (const page of pages) {
        const { error: upsertErr } = await supabase
          .from('facebook_connections')
          .upsert({
            telegram_user_id:     telegramUserId,
            fb_user_id:           fbUserId,
            fb_page_id:           page.id,
            fb_page_name:         page.name,
            fb_page_access_token: page.access_token,
            is_active:            true,
          }, { onConflict: 'telegram_user_id,fb_page_id' });

        if (upsertErr) {
          console.error('[facebook-web-login] Erreur upsert page', page.id, upsertErr);
        }
      }

      // Récupérer le web_access_token du profil utilisateur
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('web_access_token')
        .eq('telegram_user_id', telegramUserId)
        .maybeSingle();

      if (!profile?.web_access_token) {
        return json({ error: 'Profil utilisateur introuvable.' }, 404);
      }

      console.log('[facebook-web-login] ✅ connexion web réussie pour', telegramUserId);
      return json({
        ok:    true,
        pages: pages.map((p) => p.name),
        token: profile.web_access_token,
      });

    } catch (e) {
      console.error('[facebook-web-login] Exception:', e);
      return json({ error: 'Erreur interne.' }, 500);
    }
  }

  return json({ error: 'Méthode non supportée.' }, 405);
});
