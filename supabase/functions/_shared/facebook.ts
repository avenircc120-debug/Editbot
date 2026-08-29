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

async function safeJson(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    console.error('[facebook.ts] Réponse non-JSON (status', res.status, '):', text.slice(0, 200));
    return null;
  }
}

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

  await supabase.from('facebook_oauth_states').delete().eq('nonce', nonce);
  return Number(data.telegram_user_id);
}

export async function echangerCode(code: string, redirectUri: string): Promise<string | null> {
  const url = `${FB_API}/oauth/access_token` +
    `?client_id=${FB_APP_ID}` +
    `&client_secret=${FB_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`;

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

  return data.access_token ?? null;
}

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
      return shortToken;
    }
    return data.access_token ?? shortToken;
  } catch (err) {
    console.error('[prolongerToken] Exception:', err);
    return shortToken;
  }
}

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

export async function recupererPages(token: string): Promise<FbPage[]> {
  const pages: FbPage[] = [];
  let nextUrl: string | null =
    `${FB_API}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(token)}`;

  let iterations = 0;
  while (nextUrl && iterations < 10) {
    iterations++;
    try {
      const res  = await fetch(nextUrl);
      const data = await safeJson(res);
      if (!res.ok || !data || data.error) {
        console.error('[recupererPages] Erreur page', iterations, ':', JSON.stringify(data?.error ?? data));
        break;
      }

      for (const p of (data.data ?? [])) {
        if (!p.access_token) {
          console.warn('[recupererPages] Page sans access_token ignorée:', p.id, p.name);
          continue;
        }
        pages.push({ id: p.id, name: p.name, access_token: p.access_token });
      }

      nextUrl = data.paging?.next ?? null;
    } catch (err) {
      console.error('[recupererPages] Exception page', iterations, ':', err);
      break;
    }
  }

  console.log(`[recupererPages] ${pages.length} page(s) avec token récupérée(s)`);
  return pages;
}

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
    // Vérifier data.error EN PREMIER : les erreurs de jeton (révoqué, expiré,
    // session terminée...) arrivent avec un HTTP non-2xx (400/401), et le
    // corps JSON contient quand même le code numérique dont estErreurToken()
    // a besoin pour détecter la révocation — l'écraser par un message
    // générique "HTTP 401" a déjà empêché cette détection en production.
    if (data?.error) {
      return { success: false, error: `#${data.error.code} ${data.error.message}` };
    }
    if (!res.ok || !data) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true, postId: data.id };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export async function editerPost(
  postId: string,
  pageAccessToken: string,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${FB_API}/${postId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, access_token: pageAccessToken }),
    });
    const data = await safeJson(res);
    // Cf. posterSurPage : ne jamais écraser le code d'erreur par un message
    // HTTP générique, sinon estErreurToken() ne détecte jamais la révocation.
    if (data?.error) {
      return { success: false, error: `#${data.error.code} ${data.error.message}` };
    }
    if (!res.ok || !data) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export async function validerJetonPage(
  pageAccessToken: string,
): Promise<{ id: string; name: string; category: string | null } | { error: string }> {
  try {
    const res = await fetch(
      `${FB_API}/me?fields=id,name,category&access_token=${encodeURIComponent(pageAccessToken)}`,
    );
    const data = await safeJson(res);
    // Vérifier data.error EN PREMIER : Facebook renvoie un code HTTP non-2xx
    // (401/400) avec un corps JSON qui explique la vraie raison (jeton expiré,
    // révoqué, invalide…) — ne jamais l'écraser par un message générique.
    if (data?.error) return { error: data.error.message ?? 'Jeton Facebook invalide.' };
    if (!res.ok || !data) return { error: `Impossible de contacter Facebook (HTTP ${res.status}).` };
    if (!data.id || !data.name) return { error: 'Réponse Facebook incomplète.' };
    return { id: data.id, name: data.name, category: data.category ?? null };
  } catch (err) {
    return { error: `Erreur réseau : ${String(err)}` };
  }
}

export async function recupererNomUtilisateur(token: string): Promise<string> {
  try {
    const res = await fetch(`${FB_API}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const data = await safeJson(res);
    if (!data || data.error) {
      console.warn('[recupererNomUtilisateur] Erreur:', JSON.stringify(data?.error ?? data));
      return '';
    }
    return data.name ?? '';
  } catch (err) {
    console.error('[recupererNomUtilisateur] Exception:', err);
    return '';
  }
}
