/**
 * mini-app-api — Backend de la Telegram Mini App Editbot
 *
 * Routes (path suffix après /mini-app-api) :
 *   POST  /auth              → valide initData Telegram → token
 *   GET   /profile           → compétition + pages FB + ligues
 *   PATCH /competition       → changer de compétition
 *   GET   /matches           → liste matchs (live, today, all)
 *   POST  /broadcast         → activer/désactiver diffusion d'un match
 *   GET   /wallet            → solde + transactions
 *   POST  /wallet            → demande dépôt/retrait
 *   GET   /coupons           → liste coupons
 *   POST  /coupons           → ajouter coupon
 *   DELETE /coupons/:id      → supprimer coupon
 *   GET   /facebook          → liste pages connectées
 *   DELETE /facebook/:id     → déconnecter une page
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES } from '../_shared/config.ts';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BOT_TOKEN     = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ─── Auth Telegram initData ────────────────────────────────────────────────────

async function validateInitData(initData: string): Promise<number | null> {
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const enc = new TextEncoder();
    // secret_key = HMAC-SHA256(key="WebAppData", data=botToken)
    const km = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const secretKeyBytes = await crypto.subtle.sign('HMAC', km, enc.encode(BOT_TOKEN));

    // hash = HMAC-SHA256(key=secretKey, data=dataCheckString)
    const hk = await crypto.subtle.importKey(
      'raw', secretKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const hashBytes  = await crypto.subtle.sign('HMAC', hk, enc.encode(dataCheckString));
    const computed   = [...new Uint8Array(hashBytes)].map(b => b.toString(16).padStart(2, '0')).join('');

    if (computed !== hash) return null;

    const user = JSON.parse(params.get('user') ?? '{}');
    return user.id ? Number(user.id) : null;
  } catch {
    return null;
  }
}

async function getChatIdFromToken(token: string): Promise<number | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('telegram_user_id')
    .eq('web_access_token', token)
    .maybeSingle();
  return data ? Number(data.telegram_user_id) : null;
}

async function ensureProfile(chatId: number): Promise<void> {
  await supabase
    .from('user_profiles')
    .upsert({ telegram_user_id: chatId }, { onConflict: 'telegram_user_id', ignoreDuplicates: true });
}

async function getToken(chatId: number): Promise<string> {
  const { data } = await supabase
    .from('user_profiles')
    .select('web_access_token')
    .eq('telegram_user_id', chatId)
    .maybeSingle();
  return data?.web_access_token ?? '';
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleAuth(req: Request): Promise<Response> {
  const { initData } = await req.json().catch(() => ({}));
  if (!initData) return json({ error: 'initData requis' }, 400);

  const chatId = await validateInitData(initData as string);
  if (!chatId) return json({ error: 'initData invalide ou expiré' }, 401);

  await ensureProfile(chatId);
  const token = await getToken(chatId);

  return json({ chatId, token });
}

async function handleProfile(chatId: number): Promise<Response> {
  const [{ data: profil }, { data: fbPages }, { count: activeBroadcasts }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('competition_suivie, competition_suivie_id')
      .eq('telegram_user_id', chatId)
      .maybeSingle(),
    supabase
      .from('facebook_connections')
      .select('id, fb_page_name, last_post_at, created_at')
      .eq('telegram_user_id', chatId)
      .eq('is_active', true),
    supabase
      .from('broadcast_selections')
      .select('*', { count: 'exact', head: true })
      .eq('telegram_user_id', chatId)
      .eq('is_active', true)
      .then(r => r),
  ]);

  return json({
    competition:      profil?.competition_suivie      ?? null,
    competitionId:    profil?.competition_suivie_id   ?? null,
    leagues:          LEAGUES,
    fbPages:          fbPages ?? [],
    activeBroadcasts: activeBroadcasts ?? 0,
  });
}

async function handleUpdateCompetition(req: Request, chatId: number): Promise<Response> {
  const { tsdbId } = await req.json().catch(() => ({}));
  const ligue = LEAGUES.find(l => l.tsdb_id === tsdbId);
  if (!ligue) return json({ error: 'Compétition inconnue' }, 400);

  await supabase
    .from('user_profiles')
    .update({
      competition_suivie:    ligue.name,
      competition_suivie_id: ligue.tsdb_id,
      updated_at:            new Date().toISOString(),
    })
    .eq('telegram_user_id', chatId);

  return json({ ok: true, competition: ligue.name, competitionId: ligue.tsdb_id });
}

async function handleMatches(chatId: number, url: URL): Promise<Response> {
  const competitionId = url.searchParams.get('competitionId');
  const filter        = url.searchParams.get('filter') ?? 'all';

  const now     = new Date();
  const moins2h = new Date(now.getTime() - 2  * 60 * 60 * 1000).toISOString();
  const j7      = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString();
  const debJour = now.toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const finJour = now.toISOString().slice(0, 10) + 'T23:59:59.999Z';

  let q = supabase
    .from('matchs_index')
    .select('match_id, home_team, away_team, match_date, status, home_score, away_score, home_team_badge, away_team_badge, competition, tournament_id')
    .order('match_date', { ascending: true })
    .limit(60);

  if (competitionId) q = q.eq('tournament_id', competitionId);

  if (filter === 'live') {
    q = q.eq('status', 'inprogress');
  } else if (filter === 'today') {
    q = q.gte('match_date', debJour).lte('match_date', finJour);
  } else {
    q = q.gte('match_date', moins2h).lte('match_date', j7);
  }

  const { data: matchs } = await q;

  // Broadcast actifs de l'utilisateur
  const { data: selections } = await supabase
    .from('broadcast_selections')
    .select('match_id')
    .eq('telegram_user_id', chatId)
    .eq('is_active', true);

  const selected = new Set((selections ?? []).map((s: { match_id: string }) => s.match_id));

  const result = (matchs ?? []).map((m: Record<string, unknown>) => ({
    ...m,
    isBroadcasting: selected.has(m.match_id as string),
  }));

  return json({ matches: result });
}

async function handleBroadcast(req: Request, chatId: number): Promise<Response> {
  const { matchId, active, competition, homeTeam, awayTeam } = await req.json().catch(() => ({}));
  if (!matchId) return json({ error: 'matchId requis' }, 400);

  if (active) {
    await supabase.from('broadcast_selections').upsert({
      telegram_user_id: chatId,
      match_id:         matchId,
      competition:      competition ?? null,
      home_team:        homeTeam    ?? null,
      away_team:        awayTeam    ?? null,
      is_active:        true,
      created_at:       new Date().toISOString(),
    }, { onConflict: 'telegram_user_id,match_id' });
  } else {
    await supabase
      .from('broadcast_selections')
      .update({ is_active: false })
      .eq('telegram_user_id', chatId)
      .eq('match_id', matchId);
  }

  return json({ ok: true, matchId, active });
}

async function handleWalletGet(chatId: number): Promise<Response> {
  await supabase
    .from('wallets')
    .upsert({ telegram_user_id: chatId }, { onConflict: 'telegram_user_id', ignoreDuplicates: true });

  const [{ data: wallet }, { data: txs }] = await Promise.all([
    supabase.from('wallets').select('balance').eq('telegram_user_id', chatId).maybeSingle(),
    supabase
      .from('wallet_transactions')
      .select('id, type, amount, methode, note, status, created_at')
      .eq('telegram_user_id', chatId)
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  return json({ balance: (wallet as { balance: number } | null)?.balance ?? 0, transactions: txs ?? [] });
}

async function handleWalletPost(req: Request, chatId: number): Promise<Response> {
  const { action, amount, methode, note } = await req.json().catch(() => ({}));
  if (!action || !amount || Number(amount) <= 0) return json({ error: 'Paramètres invalides' }, 400);

  await supabase.from('wallet_transactions').insert({
    telegram_user_id: chatId,
    type:             action,
    amount:           Number(amount),
    methode:          methode ?? null,
    note:             note    ?? null,
    status:           'en_attente',
  });

  return json({ ok: true });
}

async function handleCouponsGet(chatId: number): Promise<Response> {
  const { data } = await supabase
    .from('coupons')
    .select('id, bookmaker, code, description, price, active, created_at')
    .eq('telegram_user_id', chatId)
    .order('created_at', { ascending: false });
  return json({ coupons: data ?? [] });
}

async function handleCouponsPost(req: Request, chatId: number): Promise<Response> {
  const { bookmaker, code, description, price } = await req.json().catch(() => ({}));
  if (!bookmaker || !code) return json({ error: 'bookmaker et code requis' }, 400);

  const { data } = await supabase
    .from('coupons')
    .insert({ telegram_user_id: chatId, bookmaker, code, description: description ?? null, price: price ?? null })
    .select()
    .single();

  return json({ ok: true, coupon: data });
}

async function handleCouponsDelete(chatId: number, couponId: string): Promise<Response> {
  await supabase
    .from('coupons')
    .delete()
    .eq('id', couponId)
    .eq('telegram_user_id', chatId);
  return json({ ok: true });
}

async function handleFacebookGet(chatId: number): Promise<Response> {
  const { data } = await supabase
    .from('facebook_connections')
    .select('id, fb_page_name, last_post_at, created_at')
    .eq('telegram_user_id', chatId)
    .eq('is_active', true);
  return json({ pages: data ?? [] });
}

async function handleFacebookDelete(chatId: number, pageId: string): Promise<Response> {
  await supabase
    .from('facebook_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', pageId)
    .eq('telegram_user_id', chatId);
  return json({ ok: true });
}

// ─── Router principal ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url   = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // ex: ['functions','v1','mini-app-api','matches']
    // ou  ['functions','v1','mini-app-api','coupons','42']
    const route       = parts[parts.length - 1];
    const parentRoute = parts[parts.length - 2];

    // ── Route publique : auth ───────────────────────────────────────────────
    if (route === 'auth' && req.method === 'POST') return handleAuth(req);

    // ── Routes authentifiées ────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return json({ error: 'Token requis' }, 401);

    const chatId = await getChatIdFromToken(token);
    if (!chatId) return json({ error: 'Token invalide ou expiré' }, 401);

    if (route === 'profile'     && req.method === 'GET')   return handleProfile(chatId);
    if (route === 'competition' && req.method === 'PATCH') return handleUpdateCompetition(req, chatId);
    if (route === 'matches'     && req.method === 'GET')   return handleMatches(chatId, url);
    if (route === 'broadcast'   && req.method === 'POST')  return handleBroadcast(req, chatId);
    if (route === 'wallet'      && req.method === 'GET')   return handleWalletGet(chatId);
    if (route === 'wallet'      && req.method === 'POST')  return handleWalletPost(req, chatId);
    if (route === 'coupons'     && req.method === 'GET')   return handleCouponsGet(chatId);
    if (route === 'coupons'     && req.method === 'POST')  return handleCouponsPost(req, chatId);
    if (parentRoute === 'coupons'  && req.method === 'DELETE') return handleCouponsDelete(chatId, route);
    if (route === 'facebook'       && req.method === 'GET')    return handleFacebookGet(chatId);
    if (parentRoute === 'facebook' && req.method === 'DELETE') return handleFacebookDelete(chatId, route);

    return json({ error: 'Route inconnue' }, 404);
  } catch (err) {
    console.error('[mini-app-api] Erreur:', err);
    return json({ error: 'Erreur interne' }, 500);
  }
});
