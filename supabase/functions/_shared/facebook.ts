/**
 * facebook.ts — Helpers Meta Graph API (OAuth + publication de posts)
 *
 * Utilisé par facebook-oauth (échange du code, récupération des Pages)
 * et facebook-post (publication automatique des scores en direct).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FB_APP_ID     = Deno.env.get('FACEBOOK_APP_ID')     ?? '';
const FB_APP_SECRET = Deno.env.get('FACEBOOK_APP_SECRET') ?? '';
const FB_API        = 'https://graph.facebook.com/v22.0';

// ─── Utilitaire ─────────────────────────────────────────────────────────────

/** Parse JSON sans jamais lancer d'exception. Retourne null si échec. */
async function safeJson(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    console.error('[facebook.ts] Réponse non-JSON (status', res.status, '):', text.slice(0, 200));
    return null;
  }
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

/** Valide un nonce anti-CSRF à usage unique et renvoie le telegram_user_id associé. */
export async function validerNonce(nonce: string, supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from('facebook_oauth_states')
    .select('telegram_user_id, expires_at')
    .eq('nonce', nonce)
    .maybeSingle();

  if (error) {
    console.error('[validerNonce] Erreur Supabase:', error);
    return null;
  }
  if (!data) {
    console.warn('[validerNonce] Nonce introuvable en base');
    return null;
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    console.warn('[validerNonce] Nonce expiré depuis', new Date(data.expires_at).toISOString());
    await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
    return null;
  }

  // Usage unique : suppression immédiate
  await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
  return Number(data.telegram_user_id);
}

/** Échange le code d'autorisation contre un token de courte durée. */
export async function echangerCode(code: string, redirectUri: string): Promise<string | null> {
  const url = `${FB_API}/oauth/access_token` +
    `?client_id=${FB_APP_ID}` +
    `&client_secret=${FB_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`;

  console.log('[echangerCode] App ID utilisé:', FB_APP_ID ? FB_APP_ID.slice(0, 6) + '…' : 'MANQUANT');
  console.log('[echangerCode] App Secret présent:', !!FB_APP_SECRET);
  console.log('[echangerCode] redirect_uri:', redirectUri);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (fetchErr) {
    console.error('[echangerCode] Erreur réseau fetch:', fetchErr);
    return null;
  }

  const data = await safeJson(res);
  if (!data) return null;

  if (!res.ok || data.error) {
    console.error('[echangerCode] Erreur Facebook:', JSON.stringify(data?.error ?? data));
    return null;
  }

  console.log('[echangerCode] Token obtenu avec succès');
  return data.access_token ?? null;
}

/** Échange un token courte durée contre un token longue durée (~60 jours). */
export async function prolongerToken(shortToken: string): Promise<string> {
  const url = `${FB_API}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${FB_APP_ID}` +
    `&client_secret=${FB_APP_SECRET}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;

  try {
    const res = await fetch(url);
    const data = await safeJson(res);
    if (!res.ok || !data || data.error) {
      console.error('[prolongerToken] Erreur:', JSON.stringify(data?.error ?? data));
      return shortToken; // fallback : on utilise le token court
    }
    console.log('[prolongerToken] Token prolongé avec succès');
    return data.access_token ?? shortToken;
  } catch (err) {
    console.error('[prolongerToken] Exception:', err);
    return shortToken;
  }
}

/** Récupère l'ID Facebook de l'utilisateur connecté. */
export async function recupererFbUserId(token: string): Promise<string> {
  try {
    const res = await fetch(`${FB_API}/me?access_token=${encodeURIComponent(token)}`);
    const data = await safeJson(res);
    if (!data || data.error) {
      console.error('[recupererFbUserId] Erreur:', JSON.stringify(data?.error ?? data));
      return '';
    }
    return data.id ?? '';
  } catch (err) {
    console.error('[recupererFbUserId] Exception:', err);
    return '';
  }
}

export interface FbPage {
  id: string;
  name: string;
  access_token: string;
}

/** Liste les Pages Facebook administrées par l'utilisateur. */
export async function recupererPages(token: string): Promise<FbPage[]> {
  try {
    const res = await fetch(`${FB_API}/me/accounts?access_token=${encodeURIComponent(token)}`);
    const data = await safeJson(res);
    if (!res.ok || !data || data.error) {
      console.error('[recupererPages] Erreur:', JSON.stringify(data?.error ?? data));
      return [];
    }
    return (data.data ?? []).map((p: any) => ({
      id:           p.id,
      name:         p.name,
      access_token: p.access_token,
    }));
  } catch (err) {
    console.error('[recupererPages] Exception:', err);
    return [];
  }
}

// ─── Publication ────────────────────────────────────────────────────────────

/** Publie un message texte sur une Page Facebook. */
export async function posterSurPage(
  pageId: string,
  pageAccessToken: string,
  message: string,
): Promise<{ success: boolean; postId?: string; error?: string }> {
  try {
    const res = await fetch(`${FB_API}/${pageId}/feed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, access_token: pageAccessToken }),
    });
    const data = await safeJson(res);
    if (!res.ok || !data) {
      return { success: false, error: data?.error?.message ?? `HTTP ${res.status}` };
    }
    if (data.error) {
      return { success: false, error: `#${data.error.code} ${data.error.message}` };
    }
    return { success: true, postId: data.id };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
