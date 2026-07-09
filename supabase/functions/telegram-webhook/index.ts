/**
 * telegram-webhook — Fonction auto-suffisante (tout inliné)
 * Pas d'imports relatifs : compatible déploiement via API Management Supabase.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Templates ───────────────────────────────────────────────────────────────
function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
  } catch { return dateStr; }
}

function templateListe(matchs: any[]): string {
  if (!matchs.length) return '📭 Aucun pronostic disponible pour le moment.\n\nLe moteur tourne la nuit — revenez demain !';
  const lignes = matchs.map((m, i) => {
    const e = m.fiabilite >= 80 ? '🟢' : m.fiabilite >= 65 ? '🟡' : '🔴';
    return `${i + 1}. ${e} *${m.home_team}* vs *${m.away_team}*\n   🏆 ${m.competition} | 📅 ${formatDate(m.match_date)}\n   ✅ ${m.pronostic_valeur} — ${m.fiabilite}%`;
  }).join('\n\n');
  return `🗓️ *PRONOSTICS*\n\n${lignes}\n\n_/detail [numéro] pour l'analyse complète_`;
}

function templateDetail(d: any): string {
  const e = d.fiabilite >= 80 ? '🟢' : d.fiabilite >= 65 ? '🟡' : '🔴';
  const warn = d.fiabilite < 70 ? '\n⚠️ *Fiabilité faible — risque élevé.*' : '';
  return `📊 *${d.competition}*\n\n⚽ *${d.home_team}* vs *${d.away_team}*\n📅 ${formatDate(d.match_date)}\n\n━━━━━━━━━━━━━━━━━━\n🎯 *Type* : ${d.pronostic_type}\n✅ *Pronostic* : \`${d.pronostic_valeur}\`\n💰 *Cote* : ${d.cote_conseille}\n${e} *Fiabilité* : ${d.fiabilite}%\n━━━━━━━━━━━━━━━━━━\n\n📝 *Analyse* :\n${d.analyse_texte}${warn}\n\n_Pariez responsablement. 18+_`;
}

function templateAide(): string {
  return `🤖 *Bot Pronostics Sportifs*\n\n📌 *Commandes* :\n\n/pronostics — Tous les pronostics du jour\n/ligue1 — Ligue 1\n/pl — Premier League\n/ldc — Champions League\n/detail [id] — Analyse complète\n/aide — Cette aide\n\n💡 *Types de paris analysés* :\n• 1X2 · BTTS · Plus\\/Moins 2.5 · Score Exact\n\n⚠️ _Pariez responsablement. 18+ uniquement._`;
}

function templateErreur(msg: string): string {
  return `❌ ${msg}`;
}

// ─── Envoi Telegram ───────────────────────────────────────────────────────────
async function send(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
}

// ─── Routing des commandes ────────────────────────────────────────────────────
async function route(chatId: number, text: string) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase().split('@')[0];
  const arg   = parts[1] ?? '';

  // /start /aide /help
  if (['/start', '/aide', '/help'].includes(cmd)) {
    return send(chatId, templateAide());
  }

  // /pronostics — tous
  if (cmd === '/pronostics') {
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('competition, home_team, away_team, match_date, pronostic_valeur, fiabilite')
      .gte('match_date', new Date().toISOString())
      .gte('expires_at', new Date().toISOString())
      .order('fiabilite', { ascending: false })
      .limit(8);
    return send(chatId, templateListe(data ?? []));
  }

  // /ligue1 /pl /ldc etc.
  const competitions: Record<string, string> = {
    '/ligue1':     'Ligue 1',
    '/pl':         'Premier League',
    '/laliga':     'La Liga',
    '/bundesliga': 'Bundesliga',
    '/seriea':     'Serie A',
    '/ldc':        'Champions League',
    '/el':         'Europa League',
  };
  if (competitions[cmd]) {
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('competition, home_team, away_team, match_date, pronostic_valeur, fiabilite')
      .eq('competition', competitions[cmd])
      .gte('match_date', new Date().toISOString())
      .gte('expires_at', new Date().toISOString())
      .order('fiabilite', { ascending: false })
      .limit(8);
    return send(chatId, templateListe(data ?? []));
  }

  // /detail [id]
  if (cmd === '/detail') {
    const num = parseInt(arg);
    if (!num) return send(chatId, templateErreur('Utilisez : /detail [numéro]'));
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('*')
      .eq('id', num)
      .single();
    if (!data) return send(chatId, templateErreur(`Pronostic #${num} introuvable.`));
    return send(chatId, templateDetail(data));
  }

  // Message libre → aide
  return send(chatId, templateAide());
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK');

  try {
    const body    = await req.json();
    const message = body.message ?? body.edited_message;
    if (!message?.text) return new Response('OK');

    await route(message.chat.id, message.text);
    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
