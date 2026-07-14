/**
 * web-portal — Page "Mon espace" Editbot
 *
 * Accessible via ?token=xxx (web_access_token stocké dans user_profiles)
 *
 * GET  ?token=xxx                              → { leagues, selectedCompetitions, coupons }
 * POST ?token=xxx  { competitions: string[] }  → met à jour les compétitions suivies
 * POST ?token=xxx  { coupon: {...} }            → ajoute un coupon
 * POST ?token=xxx  { deleteCouponId: number }  → supprime un coupon
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// ─── Valider le token et récupérer le profil ───────────────────────────────────

async function getProfil(token: string): Promise<{ telegram_user_id: number; competition_suivie: string | null } | null> {
  if (!token) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('telegram_user_id, competition_suivie')
    .eq('web_access_token', token)
    .maybeSingle();
  return data ?? null;
}

// ─── GET — données de l'espace ────────────────────────────────────────────────

async function handleGet(token: string): Promise<Response> {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré. Génère un nouveau lien depuis Telegram.' }, 401);

  const { data: coupons } = await supabase
    .from('coupons')
    .select('id, bookmaker, code, description, price, active, created_at')
    .eq('telegram_user_id', profil.telegram_user_id)
    .eq('active', true)
    .order('created_at', { ascending: false });

  const leagues = LEAGUES.map(l => `${l.flag} ${l.name}`);
  const selectedCompetitions = profil.competition_suivie ? [profil.competition_suivie] : [];

  return json({ leagues, selectedCompetitions, coupons: coupons ?? [] });
}

// ─── POST — mise à jour ────────────────────────────────────────────────────────

async function handlePost(token: string, req: Request): Promise<Response> {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré.' }, 401);

  const body = await req.json().catch(() => ({}));

  // Mise à jour des compétitions suivies
  if (body.competitions !== undefined) {
    const selected: string[] = body.competitions ?? [];
    // On garde la première compétition sélectionnée comme compétition principale
    const principale = selected.length > 0 ? selected[0] : null;
    const league = LEAGUES.find(l => `${l.flag} ${l.name}` === principale);
    await supabase
      .from('user_profiles')
      .update({
        competition_suivie:    principale,
        competition_suivie_id: league?.tsdb_id ?? null,
      })
      .eq('telegram_user_id', profil.telegram_user_id);
    return json({ ok: true });
  }

  // Ajout d'un coupon
  if (body.coupon) {
    const { bookmaker, code, description, price } = body.coupon;
    if (!bookmaker || !code) return json({ error: 'bookmaker et code sont requis' }, 400);
    const { data: coupon, error } = await supabase
      .from('coupons')
      .insert({
        telegram_user_id: profil.telegram_user_id,
        bookmaker,
        code: String(code).trim(),
        description: description || null,
        price:       price ? Number(price) : null,
        active:      true,
      })
      .select()
      .single();
    if (error) return json({ error: 'Erreur lors de l\'ajout du coupon' }, 500);
    return json({ ok: true, coupon });
  }

  // Suppression d'un coupon
  if (body.deleteCouponId) {
    await supabase
      .from('coupons')
      .update({ active: false })
      .eq('id', Number(body.deleteCouponId))
      .eq('telegram_user_id', profil.telegram_user_id);
    return json({ ok: true });
  }

  return json({ error: 'Action non reconnue' }, 400);
}

// ─── Router ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url   = new URL(req.url);
    const token = url.searchParams.get('token') ?? '';

    if (!token) {
      return json({ error: 'Token manquant. Ouvre cette page depuis le bouton sur Telegram.' }, 401);
    }

    if (req.method === 'GET')  return handleGet(token);
    if (req.method === 'POST') return handlePost(token, req);

    return json({ error: 'Méthode non supportée' }, 405);
  } catch (err) {
    console.error('[web-portal] Erreur:', err);
    return json({ error: 'Erreur interne' }, 500);
  }
});
