/**
 * wallet — API du portefeuille (dépôts, retraits, historique)
 *
 * Authentification : jeton `token` = user_profiles.web_access_token
 *
 * GET  /wallet?token=...   → { balance, transactions }
 * POST /wallet?token=...   → body { action: 'depot'|'retrait', amount, methode?, note? }
 *   Crée une demande en statut 'en_attente'. Le solde n'est mis à jour
 *   qu'une fois la demande validée manuellement (trigger DB sur
 *   wallet_transactions.status = 'validee').
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN   = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const ADMIN_CHAT_ID    = Deno.env.get('ADMIN_CHAT_ID')             ?? '';
const supabase         = createClient(SUPABASE_URL, SUPABASE_KEY);

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

async function notifierAdmin(texte: string) {
  if (!ADMIN_CHAT_ID || !TELEGRAM_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: texte, parse_mode: 'Markdown' }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const telegramUserId = await resoudreUtilisateur(token);

  if (!telegramUserId) return json({ error: 'Jeton invalide ou expiré.' }, 401);

  if (req.method === 'GET') {
    await supabase.from('wallets').upsert(
      { telegram_user_id: telegramUserId },
      { onConflict: 'telegram_user_id', ignoreDuplicates: true },
    );

    const [{ data: wallet }, { data: transactions }] = await Promise.all([
      supabase.from('wallets').select('balance').eq('telegram_user_id', telegramUserId).maybeSingle(),
      supabase
        .from('wallet_transactions')
        .select('id, type, amount, status, methode, note, created_at')
        .eq('telegram_user_id', telegramUserId)
        .order('created_at', { ascending: false })
        .limit(30),
    ]);

    return json({ balance: Number(wallet?.balance ?? 0), transactions: transactions ?? [] });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const montant = Number(body.amount);

    if (!['depot', 'retrait'].includes(body.action)) return json({ error: 'Action invalide.' }, 400);
    if (!Number.isFinite(montant) || montant <= 0) return json({ error: 'Montant invalide.' }, 400);

    if (body.action === 'retrait') {
      const { data: wallet } = await supabase.from('wallets').select('balance').eq('telegram_user_id', telegramUserId).maybeSingle();
      const solde = Number(wallet?.balance ?? 0);
      if (montant > solde) return json({ error: 'Solde insuffisant.' }, 400);
    }

    const { data: transaction, error } = await supabase
      .from('wallet_transactions')
      .insert({
        telegram_user_id: telegramUserId,
        type: body.action,
        amount: montant,
        methode: body.methode ?? null,
        note: body.note ?? null,
      })
      .select('id')
      .single();

    if (error) return json({ error: 'Impossible de créer la demande.' }, 500);

    const libelle = body.action === 'depot' ? '💰 Dépôt' : '💸 Retrait';
    await notifierAdmin(
      `${libelle} demandé\nUtilisateur Telegram : ${telegramUserId}\nMontant : ${montant} \nMéthode : ${body.methode ?? '—'}\nNote : ${body.note ?? '—'}\nID demande : ${transaction?.id}`,
    );

    return json({ success: true, id: transaction?.id });
  }

  return json({ error: 'Méthode non supportée' }, 405);
});
