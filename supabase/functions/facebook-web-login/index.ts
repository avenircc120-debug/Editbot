/**
 * facebook-web-login — Connexion Facebook pour le portail web (sans Telegram)
 *
 * GET  ?init=1   → génère un nonce, redirige vers fb-connect-web.html
 * POST {token, nonce} → valide nonce, échange token FB, retourne web_access_token
 * POST {pageAccessToken} → connexion/inscription via jeton de Page (sans Telegram)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { prolongerToken, recupererFbUserId, recupererNomUtilisateur, recupererPages, validerJetonPage } from '../_shared/facebook.ts';

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
  // ── POST {pageAccessToken} → connexion/inscription via jeton de Page (sans Telegram) ──
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({})) as {
        token?: string; nonce?: string; pageAccessToken?: string;
      };

      // ── Jeton de Page apporté par l'utilisateur : crée le compte s'il n'existe pas ──
      if (typeof body.pageAccessToken === 'string') {
        const pageAccessToken = body.pageAccessToken.trim();
        if (!pageAccessToken) return json({ error: 'Le jeton d’accès de Page est requis.' }, 400);

        const result = await validerJetonPage(pageAccessToken);
        if ('error' in result) return json({ error: `Jeton refusé par Facebook : ${result.error}` }, 400);
        if (!result.category) {
          return json({
            error: 'Ce jeton correspond à un profil personnel, pas à une Page Facebook. ' +
              'Génère un jeton d’accès de PAGE (pas d’utilisateur) depuis ton App Meta.',
          }, 400);
        }

        const pageId = result.id;

        // Retrouver le compte Editbot déjà lié à cette Page, sinon en créer un nouveau
        // (identifiant synthétique négatif, réservé aux comptes web sans Telegram —
        //  les identifiants Telegram réels sont toujours positifs).
        const { data: existingConn } = await supabase
          .from('facebook_connections')
          .select('telegram_user_id')
          .eq('fb_page_id', pageId)
          .limit(1)
          .maybeSingle();

        const userId = existingConn ? BigInt(existingConn.telegram_user_id) : -BigInt(pageId);

        if (!existingConn) {
          const { error: profileErr } = await supabase
            .from('user_profiles')
            .upsert({ telegram_user_id: userId.toString() }, { onConflict: 'telegram_user_id', ignoreDuplicates: true });
          if (profileErr) {
            console.error('[facebook-web-login] Erreur création profil web:', profileErr);
            return json({ error: 'Impossible de créer le compte.' }, 500);
          }
        }

        const { error: upsertErr } = await supabase.from('facebook_connections').upsert({
          telegram_user_id:     userId.toString(),
          fb_user_id:           pageId,
          fb_page_id:           pageId,
          fb_page_name:         result.name,
          fb_page_access_token: pageAccessToken,
          is_active:            true,
          updated_at:           new Date().toISOString(),
        }, { onConflict: 'telegram_user_id,fb_page_id' });

        if (upsertErr) {
          console.error('[facebook-web-login] Erreur upsert page (jeton manuel):', upsertErr);
          return json({ error: 'Impossible d’enregistrer la Page Facebook.' }, 500);
        }

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('web_access_token')
          .eq('telegram_user_id', userId.toString())
          .maybeSingle();

        if (!profile?.web_access_token) {
          return json({ error: 'Profil utilisateur introuvable.' }, 404);
        }

        console.log('[facebook-web-login] ✅ connexion web (jeton manuel) réussie pour', userId.toString());
        return json({
          ok:    true,
          page:  { fb_page_id: pageId, fb_page_name: result.name },
          token: profile.web_access_token,
        });
      }

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
      const [longToken, fbUserId, fbUserName] = await Promise.all([
        prolongerToken(shortToken),
        recupererFbUserId(shortToken),
        recupererNomUtilisateur(shortToken),
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
      const savedPageIds: string[] = [];
      for (const page of pages) {
        const { error: upsertErr } = await supabase
          .from('facebook_connections')
          .upsert({
            telegram_user_id:     telegramUserId,
            fb_user_id:           fbUserId,
            fb_page_id:           page.id,
            fb_page_name:         page.name,
            fb_page_access_token: page.access_token,
            fb_user_name:         fbUserName ?? null,
            is_active:            true,
            updated_at:           new Date().toISOString(),
          }, { onConflict: 'telegram_user_id,fb_page_id' });

        if (upsertErr) {
          console.error('[facebook-web-login] Erreur upsert page', page.id, upsertErr);
        } else {
          savedPageIds.push(page.id);
        }
      }

      // ── Désactiver les pages de CE compte FB qui ne sont plus retournées ────────
      // L'utilisateur a pu ne sélectionner qu'un sous-ensemble de Pages dans le
      // sélecteur Facebook (ou révoqué l'accès à certaines) : on ne garde actives
      // que celles réellement couvertes par ce jeton, pour ce même compte Facebook.
      if (savedPageIds.length > 0) {
        const { data: staleRows, error: staleErr } = await supabase
          .from('facebook_connections')
          .select('id, fb_page_id, fb_page_name')
          .eq('telegram_user_id', telegramUserId)
          .eq('fb_user_id', fbUserId)
          .eq('is_active', true)
          .not('fb_page_id', 'in', `(${savedPageIds.join(',')})`);

        if (staleErr) {
          console.warn('[facebook-web-login] Impossible de vérifier les pages obsolètes:', staleErr);
        } else if (staleRows && staleRows.length > 0) {
          const staleIds = staleRows.map((r: any) => r.id);
          const staleNames = staleRows.map((r: any) => r.fb_page_name ?? r.fb_page_id).join(', ');
          console.log(`[facebook-web-login] Désactivation de ${staleIds.length} page(s) obsolète(s): ${staleNames}`);
          await supabase
            .from('facebook_connections')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .in('id', staleIds);
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
