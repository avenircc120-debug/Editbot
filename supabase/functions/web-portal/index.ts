/**
 * web-portal — Mon espace Editbot v3
 * Wallet | Facebook | Coupons | Competitions
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

async function handleGet(token, url) {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré. Génère un nouveau lien depuis Telegram.' }, 401);

  const chatId = profil.telegram_user_id;
  const action = url.searchParams.get('action') ?? '';

  // URL OAuth Facebook
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

  // Matchs d'une compétition
  if (action === 'matches') {
    const competitionId = url.searchParams.get('competitionId') ?? '';
    const filter        = url.searchParams.get('filter') ?? 'all';
    const now     = new Date();
    const moins2h = new Date(now.getTime() - 2  * 60 * 60 * 1000).toISOString();
    const j7      = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString();
    const debJour = now.toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const finJour = now.toISOString().slice(0, 10) + 'T23:59:59.999Z';

    let q = supabase
      .from('matchs_index')
      .select('match_id,home_team,away_team,match_date,status,home_score,away_score,competition,tournament_id')
      .order('match_date', { ascending: true })
      .limit(60);

    if (competitionId) q = q.eq('tournament_id', competitionId);
    if (filter === 'live')       q = q.eq('status', 'inprogress');
    else if (filter === 'today') q = q.gte('match_date', debJour).lte('match_date', finJour);
    else                         q = q.gte('match_date', moins2h).lte('match_date', j7);

    const [{ data: matchs }, { data: selections }] = await Promise.all([
      q,
      supabase.from('broadcast_selections')
        .select('match_id')
        .eq('telegram_user_id', chatId)
        .eq('is_active', true),
    ]);

    return json({
      matches: matchs ?? [],
      broadcastIds: (selections ?? []).map(s => s.match_id),
    });
  }

  // Données principales
  const [walletRes, txRes, fbRes, couponsRes] = await Promise.all([
    supabase.from('wallets').select('balance').eq('telegram_user_id', chatId).maybeSingle(),
    supabase.from('wallet_transactions').select('id,type,amount,status,methode,note,created_at')
      .eq('telegram_user_id', chatId).order('created_at', { ascending: false }).limit(20),
    supabase.from('facebook_connections').select('id,fb_page_id,fb_page_name,fb_user_id,fb_user_name,connected_at,is_active')
      .eq('telegram_user_id', chatId).eq('is_active', true).order('fb_user_id', { ascending: true }).order('fb_page_name', { ascending: true }),
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
    const pid = Number(body.disconnectFbPageId);
    if (!Number.isInteger(pid) || pid <= 0) return json({ error: 'id invalide' }, 400);
    await supabase.from('facebook_connections').update({ is_active: false })
      .eq('id', pid).eq('telegram_user_id', chatId);
    return json({ ok: true });
  }

  if (body.disconnectFbAccountId) {
    const fbUserId = String(body.disconnectFbAccountId).trim();
    if (!fbUserId) return json({ error: 'fb_user_id requis' }, 400);
    await supabase.from('facebook_connections').update({ is_active: false })
      .eq('fb_user_id', fbUserId).eq('telegram_user_id', chatId);
    return json({ ok: true });
  }

  if (body.broadcast) {
    const { matchId, active, competition, homeTeam, awayTeam } = body.broadcast;
    if (!matchId) return json({ error: 'matchId requis' }, 400);
    if (active) {
      await supabase.from('broadcast_selections').upsert({
        telegram_user_id: chatId, match_id: matchId,
        competition: competition ?? null, home_team: homeTeam ?? null, away_team: awayTeam ?? null,
        is_active: true, created_at: new Date().toISOString(),
      }, { onConflict: 'telegram_user_id,match_id' });
    } else {
      await supabase.from('broadcast_selections').update({ is_active: false })
        .eq('telegram_user_id', chatId).eq('match_id', matchId);
    }
    return json({ ok: true, matchId, active });
  }

  if (body.coupon) {
    const { bookmaker, code, description, price } = body.coupon;
    if (!bookmaker || !code) return json({ error: 'bookmaker et code requis' }, 400);
    const { data: coupon, error } = await supabase.from('coupons').insert({
      telegram_user_id: chatId, bookmaker, code: String(code).trim(),
      description: description || null, price: price ? Number(price) : null, active: true,
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
    const url = new URL(req.url);
    const token = url.searchParams.get('token') ?? '';
    if (!token) return json({ error: 'Token manquant. Ouvre cette page depuis Telegram.' }, 401);
    if (req.method === 'GET')  return handleGet(token, url);
    if (req.method === 'POST') return handlePost(token, req);
    return json({ error: 'Méthode non supportée' }, 405);
  } catch (err) {
    console.error('[web-portal] Erreur:', err);
    return json({ error: 'Erreur interne' }, 500);
  }
});
