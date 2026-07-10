/**
 * morning-wakeup — Notification matinale automatique
 *
 * Déclenché chaque matin par cron Supabase (pg_cron).
 * Vérifie s'il y a des matchs programmés aujourd'hui, et si oui, prévient
 * tous les utilisateurs enregistrés dans leur chat privé Telegram.
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { messageReveilMatinal } from '../_shared/templates.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const CRON_SECRET    = Deno.env.get('CRON_SECRET')               ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const aujourdhui = new Date().toISOString().slice(0, 10);

  const { count } = await supabase
    .from('matchs_index')
    .select('match_id', { count: 'exact', head: true })
    .gte('match_date', `${aujourdhui}T00:00:00Z`)
    .lte('match_date', `${aujourdhui}T23:59:59Z`);

  if (!count) {
    return new Response(JSON.stringify({ success: true, matchsAujourdhui: 0, notifies: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  const { data: utilisateurs } = await supabase.from('user_profiles').select('telegram_user_id');
  const message = messageReveilMatinal(count);

  let notifies = 0;
  for (const u of utilisateurs ?? []) {
    try {
      await sendTelegram(Number(u.telegram_user_id), message);
      notifies++;
    } catch (e) {
      console.warn('[morning-wakeup] échec envoi', u.telegram_user_id, e);
    }
  }

  return new Response(JSON.stringify({ success: true, matchsAujourdhui: count, notifies }), { headers: { 'Content-Type': 'application/json' } });
});
