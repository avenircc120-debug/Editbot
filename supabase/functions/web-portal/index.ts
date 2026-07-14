/**
 * web-portal — Page "Mon espace" Editbot
 * Déployé via API — imports relatifs inlinés
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const LEAGUES = [
  { tsdb_id: '4334', name: 'Ligue 1',             flag: '🇫🇷' },
  { tsdb_id: '4328', name: 'Premier League',       flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { tsdb_id: '4335', name: 'La Liga',              flag: '🇪🇸' },
  { tsdb_id: '4331', name: 'Bundesliga',           flag: '🇩🇪' },
  { tsdb_id: '4332', name: 'Serie A',              flag: '🇮🇹' },
  { tsdb_id: '4480', name: 'Champions League',     flag: '🏆' },
  { tsdb_id: '4481', name: 'Europa League',        flag: '🟠' },
  { tsdb_id: '4329', name: 'Championship',         flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { tsdb_id: '4337', name: 'Eredivisie',           flag: '🇳🇱' },
  { tsdb_id: '4344', name: 'Primeira Liga',        flag: '🇵🇹' },
  { tsdb_id: '4346', name: 'MLS',                  flag: '🇺🇸' },
  { tsdb_id: '4351', name: 'Brasileirao',          flag: '🇧🇷' },
  { tsdb_id: '4350', name: 'Liga MX',              flag: '🇲🇽' },
  { tsdb_id: '4406', name: 'Liga Argentina',       flag: '🇦🇷' },
  { tsdb_id: '4359', name: 'Chinese Super League', flag: '🇨🇳' },
  { tsdb_id: '4429', name: 'Coupe du Monde FIFA',  flag: '🌍' },
  { tsdb_id: '4330', name: 'Scottish Premiership', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function getProfil(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('telegram_user_id, competition_suivie')
    .eq('web_access_token', token)
    .maybeSingle();
  return data ?? null;
}

async function handleGet(token) {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré. Génère un nouveau lien depuis Telegram.' }, 401);

  const { data: coupons } = await supabase
    .from('coupons')
    .select('id, bookmaker, code, description, price, active, created_at')
    .eq('telegram_user_id', profil.telegram_user_id)
    .eq('active', true)
    .order('created_at', { ascending: false });

  const leagues = LEAGUES.map(l => l.flag + ' ' + l.name);
  const selectedCompetitions = profil.competition_suivie ? [profil.competition_suivie] : [];

  return json({ leagues, selectedCompetitions, coupons: coupons ?? [] });
}

async function handlePost(token, req) {
  const profil = await getProfil(token);
  if (!profil) return json({ error: 'Lien invalide ou expiré.' }, 401);

  const body = await req.json().catch(() => ({}));

  if (body.competitions !== undefined) {
    const selected = body.competitions ?? [];
    const principale = selected.length > 0 ? selected[0] : null;
    const league = principale ? LEAGUES.find(l => (l.flag + ' ' + l.name) === principale) : null;
    await supabase
      .from('user_profiles')
      .update({
        competition_suivie:    principale,
        competition_suivie_id: league?.tsdb_id ?? null,
      })
      .eq('telegram_user_id', profil.telegram_user_id);
    return json({ ok: true });
  }

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
        price: price ? Number(price) : null,
        active: true,
      })
      .select()
      .single();
    if (error) return json({ error: "Erreur ajout coupon: " + error.message }, 500);
    return json({ ok: true, coupon });
  }

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url   = new URL(req.url);
    const token = url.searchParams.get('token') ?? '';

    if (!token) return json({ error: 'Token manquant. Ouvre cette page depuis Telegram.' }, 401);

    if (req.method === 'GET')  return handleGet(token);
    if (req.method === 'POST') return handlePost(token, req);

    return json({ error: 'Méthode non supportée' }, 405);
  } catch (err) {
    console.error('[web-portal] Erreur:', err);
    return json({ error: 'Erreur interne' }, 500);
  }
});
