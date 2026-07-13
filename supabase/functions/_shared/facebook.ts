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

// ─── OAuth ──────────────────────────────────────────────────────────────────

/** Valide un nonce anti-CSRF à usage unique et renvoie le telegram_user_id associé. */
export async function validerNonce(nonce: string, supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from('facebook_oauth_states')
    .select('telegram_user_id, expires_at')
    .eq('nonce', nonce)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  // Usage unique : on supprime immédiatement le nonce.
  await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
  return Number(data.telegram_user_id);
}

/** Échange le code d'autorisation contre un token de courte durée. */
export async function echangerCode(code: string, redirectUri: string): Promise<string | null> {
  const url = `${FB_API}/oauth/access_token?client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    // Log l'erreur Facebook réelle pour le diagnostic
    console.error('[echangerCode] Facebook error:', JSON.stringify(data?.error ?? data));
    return null;
  }
  return data.access_token ?? null;
}

/** Échange un token courte durée contre un token longue durée (~60 jours). */
export async function prolongerToken(shortToken: string): Promise<string> {
  const url = `${FB_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${shortToken}`;
  const res = await fetch(url);
  if (!res.ok) return shortToken;
  const data = await res.json();
  return data.access_token ?? shortToken;
}

export async function recupererFbUserId(token: string): Promise<string> {
  const res = await fetch(`${FB_API}/me?access_token=${token}`);
  const data = await res.json();
  return data.id ?? '';
}

export interface FbPage {
  id: string;
  name: string;
  access_token: string;
}

/** Liste les Pages Facebook administrées par l'utilisateur. */
export async function recupererPages(token: string): Promise<FbPage[]> {
  const res = await fetch(`${FB_API}/me/accounts?access_token=${token}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data ?? []).map((p: any) => ({ id: p.id, name: p.name, access_token: p.access_token }));
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, access_token: pageAccessToken }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data?.error?.message ?? `HTTP ${res.status}` };
    return { success: true, postId: data.id };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
