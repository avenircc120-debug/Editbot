import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { templatePronostic, templateListe, templateAide, templateErreur } from '../_shared/templates.ts';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
}

async function handleCommand(chatId: number, text: string) {
  const cmd = text.split(' ')[0].toLowerCase().replace('@', '');
  const arg = text.split(' ')[1] ?? '';

  if (cmd === '/start' || cmd === '/aide' || cmd === '/help') {
    await sendMessage(chatId, templateAide());
    return;
  }

  if (cmd === '/pronostics') {
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('competition, home_team, away_team, match_date, pronostic_valeur, fiabilite')
      .gte('match_date', new Date().toISOString())
      .order('fiabilite', { ascending: false })
      .limit(5);
    await sendMessage(chatId, templateListe(data?.map(d => ({
      competition: d.competition,
      homeTeam: d.home_team,
      awayTeam: d.away_team,
      matchDate: d.match_date,
      pronosticValeur: d.pronostic_valeur,
      fiabilite: d.fiabilite,
    })) ?? []));
    return;
  }

  // Filtrage par compétition
  const competitionMap: Record<string, string> = {
    '/ligue1': 'Ligue 1',
    '/pl': 'Premier League',
    '/laliga': 'La Liga',
    '/bundesliga': 'Bundesliga',
    '/seriea': 'Serie A',
    '/ldc': 'Champions League',
    '/el': 'Europa League',
  };

  if (competitionMap[cmd]) {
    const competition = competitionMap[cmd];
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('competition, home_team, away_team, match_date, pronostic_valeur, fiabilite')
      .eq('competition', competition)
      .gte('match_date', new Date().toISOString())
      .order('fiabilite', { ascending: false })
      .limit(5);
    await sendMessage(chatId, templateListe(data?.map(d => ({
      competition: d.competition,
      homeTeam: d.home_team,
      awayTeam: d.away_team,
      matchDate: d.match_date,
      pronosticValeur: d.pronostic_valeur,
      fiabilite: d.fiabilite,
    })) ?? []));
    return;
  }

  if (cmd === '/detail' && arg) {
    const { data } = await supabase
      .from('pronostics_pre_calcules')
      .select('*')
      .eq('id', parseInt(arg))
      .single();

    if (!data) {
      await sendMessage(chatId, templateErreur(`Pronostic #${arg} introuvable.`));
      return;
    }

    await sendMessage(chatId, templatePronostic({
      competition: data.competition,
      homeTeam: data.home_team,
      awayTeam: data.away_team,
      matchDate: data.match_date,
      pronosticType: data.pronostic_type,
      pronosticValeur: data.pronostic_valeur,
      fiabilite: data.fiabilite,
      coteConseille: data.cote_conseille,
      analyseTexte: data.analyse_texte,
    }));
    return;
  }

  await sendMessage(chatId, templateAide());
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 });

  try {
    const body = await req.json();
    const message = body.message ?? body.edited_message;
    if (!message?.text) return new Response('OK', { status: 200 });

    const chatId = message.chat.id;
    const text = message.text.trim();

    await handleCommand(chatId, text);
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
