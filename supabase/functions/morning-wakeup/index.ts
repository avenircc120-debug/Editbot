/**
 * morning-wakeup — Notification matinale personnalisée
 *
 * Déclenché chaque matin par cron Supabase.
 * Pour chaque utilisateur ayant une compétition sélectionnée,
 * envoie la liste des matchs de SA compétition prévus aujourd'hui.
 * Si aucun match pour sa compétition → pas de message (pas de spam).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { messageReveilMatinal } from '../_shared/templates.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const CRON_SECRET    = Deno.env.get('CRON_SECRET')               ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
  });
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const aujourd = new Date().toISOString().slice(0, 10);

  // Récupère tous les utilisateurs avec une compétition sélectionnée
  const { data: utilisateurs } = await supabase
    .from('user_profiles')
    .select('telegram_user_id, competition_suivie, competition_suivie_id')
    .not('competition_suivie', 'is', null)
    .not('competition_suivie_id', 'is', null);

  const stats = { notifies: 0, sansMatchs: 0, erreurs: 0 };

  for (const u of utilisateurs ?? []) {
    try {
      // Matchs de SA compétition aujourd'hui
      const { data: matchs } = await supabase
        .from('matchs_index')
        .select('home_team, away_team, match_date, status')
        .eq('tournament_id', u.competition_suivie_id)
        .gte('match_date', `${aujourd}T00:00:00Z`)
        .lte('match_date', `${aujourd}T23:59:59Z`)
        .neq('status', 'postponed')
        .order('match_date', { ascending: true });

      if (!matchs?.length) {
        stats.sansMatchs++;
        continue; // Pas de match aujourd'hui → pas de notification
      }

      const message = messageReveilMatinal(u.competition_suivie, matchs);

      await sendTelegram(Number(u.telegram_user_id), message, {
        inline_keyboard: [
          [
            { text: '🔴 En direct',    callback_data: 'voir_direct'    },
            { text: '📆 Programme 7j', callback_data: 'voir_programme' },
          ],
        ],
      });

      stats.notifies++;
    } catch (e) {
      stats.erreurs++;
      console.warn('[morning-wakeup] échec', u.telegram_user_id, e);
    }
  }

  return new Response(JSON.stringify({ success: true, ...stats }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
