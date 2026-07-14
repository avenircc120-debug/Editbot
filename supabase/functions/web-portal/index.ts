/**
 * web-portal — Mon espace Editbot v2
 * Wallet | Facebook | Coupons — imports inlinés
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const REDIRECT_URI    = SUPABASE_URL + '/functions/v1/facebook-oauth';
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function getProfil(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('telegram_user_id, competition_suivie, competition_suivie_id')
    .eq('web_access_token', token)
    .maybeSingle();
  return data ?? null;
}

async function handleGet(token, action) {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré. Génère un nouveau lien depuis Telegram.' }, 401);

  const chatId = profil.telegram_user_id;

  if (action === 'fb_connect_url') {
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase.from('facebook_oauth_states').insert({ state: nonce, telegram_user_id: chatId, expires_at: expiresAt });
    const fbUrl = 'https://www.facebook.com/v19.0/dialog/oauth'
      + '?client_id=' + FACEBOOK_APP_ID
      + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
      + '&state=' + nonce
      + '&scope=pages_manage_posts%2Cpages_read_engagement%2Cpages_show_list';
    return json({ url: fbUrl });
  }

  const [walletRes, txRes, fbRes, couponsRes] = await Promise.all([
    supabase.from('wallets').select('balance').eq('telegram_user_id', chatId).maybeSingle(),
    supabase.from('wallet_transactions').select('id,type,amount,status,methode,note,created_at')
      .eq('telegram_user_id', chatId).order('created_at', { ascending: false }).limit(20),
    supabase.from('facebook_connections').select('id,fb_page_name,connected_at,is_active,last_post_at')
      .eq('telegram_user_id', chatId).eq('is_active', true).order('connected_at', { ascending: false }),
    supabase.from('coupons').select('id,bookmaker,code,description,price,created_at')
      .eq('telegram_user_id', chatId).eq('active', true).order('created_at', { ascending: false }),
  ]);

  return json({
    wallet: { balance: walletRes.data?.balance ?? 0, transactions: txRes.data ?? [] },
    fbPages: fbRes.data ?? [],
    coupons: couponsRes.data ?? [],
  });
}

async function handlePost(token, req) {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré.' }, 401);

  const chatId = profil.telegram_user_id;
  const body   = await req.json().catch(() => ({}));

  if (body.wallet) {
    const { type, amount, methode, note } = body.wallet;
    if (!type || !amount || amount <= 0) return json({ error: 'Type et montant requis' }, 400);
    await supabase.from('wallet_transactions').insert({
      telegram_user_id: chatId, type, amount: Number(amount),
      methode: methode || null, note: note || null, status: 'en_attente',
    });
    return json({ ok: true });
  }

  if (body.disconnectFbPageId) {
    await supabase.from('facebook_connections')
      .update({ is_active: false })
      .eq('id', Number(body.disconnectFbPageId))
      .eq('telegram_user_id', chatId);
    return json({ ok: true });
  }

  if (body.coupon) {
    const { bookmaker, code, description, price } = body.coupon;
    if (!bookmaker || !code) return json({ error: 'bookmaker et code requis' }, 400);
    const { data: coupon, error } = await supabase.from('coupons').insert({
      telegram_user_id: chatId, bookmaker,
      code: String(code).trim(), description: description || null,
      price: price ? Number(price) : null, active: true,
    }).select().single();
    if (error) return json({ error: 'Erreur: ' + error.message }, 500);
    return json({ ok: true, coupon });
  }

  if (body.deleteCouponId) {
    await supabase.from('coupons').update({ active: false })
      .eq('id', Number(body.deleteCouponId)).eq('telegram_user_id', chatId);
    return json({ ok: true });
  }

  return json({ error: 'Action non reconnue' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    const url    = new URL(req.url);
    const token  = url.searchParams.get('token') ?? '';
    const action = url.searchParams.get('action') ?? '';
    if (!token) return json({ error: 'Token manquant. Ouvre cette page depuis Telegram.' }, 401);
    if (req.method === 'GET')  return handleGet(token, action);
    if (req.method === 'POST') return handlePost(token, req);
    return json({ error: 'Méthode non supportée' }, 405);
  } catch (err) {
    console.error('[web-portal] Erreur:', err);
    return json({ error: 'Erreur interne' }, 500);
  }
});
