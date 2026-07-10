/**
 * web-portal — API pour la page web externe (compétitions suivies + coupons)
 *
 * Authentification : jeton `token` = user_profiles.web_access_token
 * (généré automatiquement lors de la connexion Facebook / du premier /start).
 *
 * GET  /web-portal?token=...             → { leagues, selectedCompetitions, coupons }
 * POST /web-portal?token=...             → body { competitions?: string[], coupon?: { bookmaker, code, description?, price? } }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

async function resoudreUtilisateur(token: string | null) {
  if (!token) return null;
  const { data } = await supabase.from('user_profiles').select('telegram_user_id').eq('web_access_token', token).maybeSingle();
  return data ? Number(data.telegram_user_id) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const telegramUserId = await resoudreUtilisateur(token);

  if (!telegramUserId) return json({ error: 'Jeton invalide ou expiré.' }, 401);

  if (req.method === 'GET') {
    const [{ data: selection }, { data: coupons }] = await Promise.all([
      supabase.from('user_competitions').select('competition').eq('telegram_user_id', telegramUserId).eq('active', true),
      supabase.from('coupons').select('id, bookmaker, code, description, price, active, created_at').eq('telegram_user_id', telegramUserId).order('created_at', { ascending: false }),
    ]);

    return json({
      leagues: LEAGUES.map((l) => l.name),
      selectedCompetitions: (selection ?? []).map((s) => s.competition),
      coupons: coupons ?? [],
    });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    if (Array.isArray(body.competitions)) {
      await supabase.from('user_competitions').delete().eq('telegram_user_id', telegramUserId);
      const lignes = body.competitions
        .filter((c: string) => LEAGUES.some((l) => l.name === c))
        .map((c: string) => ({ telegram_user_id: telegramUserId, competition: c, active: true }));
      if (lignes.length) await supabase.from('user_competitions').insert(lignes);
    }

    if (body.coupon && body.coupon.code && body.coupon.bookmaker) {
      await supabase.from('coupons').insert({
        telegram_user_id: telegramUserId,
        bookmaker:        body.coupon.bookmaker,
        code:             body.coupon.code,
        description:      body.coupon.description ?? null,
        price:            body.coupon.price ?? null,
      });
    }

    if (body.deleteCouponId) {
      await supabase.from('coupons').delete().eq('id', body.deleteCouponId).eq('telegram_user_id', telegramUserId);
    }

    return json({ success: true });
  }

  return json({ error: 'Méthode non supportée' }, 405);
});
