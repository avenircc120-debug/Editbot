/**
 * telegram-webhook v3 — Bot humain et conversationnel
 * - Ton chaleureux et naturel, comme un ami qui s'y connaît en foot
 * - Groq avec personnalité forte + contexte pronostics 7 jours
 * - Fallback élégant si quota épuisé
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY       = Deno.env.get('GROQ_API_KEY') ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Quota Groq ───────────────────────────────────────────────────────────────
async function consommerGroq(): Promise<boolean> {
  const { data } = await supabase.rpc('quota_consommer', { p_api: 'groq' });
  return data !== false;
}

// ─── Envoi Telegram ───────────────────────────────────────────────────────────
async function send(chatId: number, text: string) {
  const chunks = text.match(/.{1,4000}(\s|$)/gs) ?? [text];
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  chatId,
        text:                     chunk.trim(),
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
      }),
    });
  }
}

async function typing(chatId: number) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  });
}

// ─── Charger les pronostics (7 jours à venir) ─────────────────────────────────
async function chargerPronostics(): Promise<{ donnees: string; count: number; matchsResume: string }> {
  const now    = new Date().toISOString();
  const in7j   = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const { data: pronos } = await supabase
    .from('pronostics_finaux')
    .select('competition, home_team, away_team, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte')
    .gte('match_date', now)
    .lte('match_date', in7j)
    .gte('expires_at', now)
    .order('fiabilite', { ascending: false })
    .limit(30);

  if (!pronos?.length) return { donnees: '', count: 0, matchsResume: '' };

  // Grouper par match
  const parMatch: Record<string, any[]> = {};
  for (const p of pronos) {
    const key = `${p.home_team} vs ${p.away_team}`;
    if (!parMatch[key]) parMatch[key] = [];
    parMatch[key].push(p);
  }

  // Format lisible pour Groq (contexte interne)
  const lignes: string[] = [];
  // Format résumé pour l'affichage direct
  const resume: string[] = [];

  for (const [matchKey, types] of Object.entries(parMatch)) {
    const first = types[0];
    const date  = new Date(first.match_date).toLocaleDateString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
    const dateShort = new Date(first.match_date).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });

    lignes.push(`\n📅 ${date} — ${first.competition}`);
    lignes.push(`⚽ ${matchKey}`);
    resume.push(`\n*⚽ ${matchKey}*  _${first.competition} · ${dateShort}_`);

    for (const t of types) {
      const fiab  = t.fiabilite >= 75 ? '🟢' : t.fiabilite >= 60 ? '🟡' : '🔴';
      lignes.push(`  → ${t.pronostic_type}: *${t.pronostic_valeur}* | fiabilité ${t.fiabilite}% | cote ${t.cote_conseille}`);
      if (t.analyse_texte) lignes.push(`    Analyse: ${t.analyse_texte}`);
      resume.push(`${fiab} *${t.pronostic_type}:* ${t.pronostic_valeur}  _(${t.fiabilite}% · cote ${t.cote_conseille})_`);
    }
  }

  return {
    donnees:      lignes.join('\n'),
    count:        pronos.length,
    matchsResume: resume.join('\n'),
  };
}

// ─── Appel Groq — personnalité humaine forte ──────────────────────────────────
async function groqReponse(userMessage: string, donnees: string, prenom?: string): Promise<string> {
  const appelUtilisateur = prenom ? prenom : 'mon ami';

  const systemPrompt = `Tu es *Edi*, un pote qui s'y connaît vraiment en foot et en paris sportifs.
Tu parles français de façon naturelle, décontractée et directe — comme un ami, pas comme un robot.
${prenom ? `L'utilisateur s'appelle ${prenom}.` : ''}

Tes règles :
- Parle comme un humain : contractions, expressions naturelles ("franchement", "honnêtement", "vas-y", "clairement", etc.)
- Ne commence JAMAIS par "Bien sûr", "Certainement", "Absolument" ou tout mot de robot
- Sois direct et personnel — exprime TON avis sur les matchs
- Utilise les émojis avec modération (1-2 max par réponse), jamais en début de phrase
- Quand tu analyses un match, montre de l'enthousiasme ou de la prudence selon la situation
- Si tu n'es pas sûr, dis-le franchement
- Garde tes réponses courtes et punchy (4-6 phrases max)
- Tu n'es PAS une IA, tu es Edi, un passionné de foot

Données pronostics disponibles (7 jours à venir) :
${donnees || '(aucun match disponible cette semaine)'}

Si l'utilisateur pose une question sur un match spécifique, base-toi sur ces données.
Si aucune donnée n'est disponible pour ce match, dis-le simplement sans t'excuser excessivement.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      max_tokens:  400,
      temperature: 0.85,
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim()
    ?? "J'ai un petit bug là, réessaie dans quelques secondes 👊";
}

// ─── Réponses immédiates sans Groq ───────────────────────────────────────────
function reponseInstantanee(text: string, prenom?: string): string | null {
  const t    = text.toLowerCase().trim();
  const nom  = prenom ?? '';
  const salut = nom ? `${nom} !` : '!';

  if (/\/start/.test(t)) {
    return `Yo${nom ? ' ' + nom : ''} 👋\n\nMoi c'est *Edi*, ton pote pour les pronostics foot.\n\nJ'analyse les matchs de la semaine et je te donne mon avis honnête — 1X2, BTTS, Over/Under et tout ça.\n\nDemande-moi n'importe quoi sur les matchs à venir, ou tape /pronostics pour voir ce que j'ai préparé !`;
  }

  if (/\/aide|\/help/.test(t)) {
    return `Voilà comment ça marche :\n\n📋 */pronostics* — Mes pronos de la semaine\n💬 *Question libre* — Pose-moi n'importe quoi sur un match\n\nExemples :\n• _"Qui va gagner ce soir ?"_\n• _"T'en penses quoi du match CL ?"_\n• _"Y'a du BTTS intéressant cette semaine ?"_`;
  }

  if (/^(bonjour|bonsoir|salut|hello|hi|cc|coucou|yo|wesh)\b/.test(t)) {
    const heures = new Date().getUTCHours() + 1;
    const moment = heures < 12 ? 'Bonjour' : heures < 19 ? 'Salut' : 'Bonsoir';
    return `${moment}${salut} Quoi de neuf ?\n\nJ'ai des pronos frais pour cette semaine si t'as envie de jeter un œil 👀`;
  }

  if (/qui (t.a|t'a) (cr[eé]e?r?|fait|construit|d[eé]velopp)/i.test(text)) {
    return `C'est *Avenir CC* qui m'a créé — un dev passionné de foot et d'IA.\n\nMoi je suis *Edi*, le moteur de pronostics sportifs derrière tout ça. Je tourne sur des données réelles, pas du vent 😉`;
  }

  if (/qui es.tu|t'es qui|c'est quoi|c'est qui edi/i.test(text)) {
    return `Je suis *Edi*, un assistant de pronostics foot.\n\nConcrètement : je récupère les données des matchs, je les analyse et je te donne mon avis sur ce qui vaut le coup de jouer. Pas de blabla, que du concret 🎯`;
  }

  if (/merci/i.test(t)) {
    return `Avec plaisir ! Et si t'as d'autres questions sur les matchs, hésite pas 🤝`;
  }

  return null;
}

// ─── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK');

  try {
    const body    = await req.json();
    const message = body.message ?? body.edited_message;
    if (!message?.text) return new Response('OK');

    const chatId = message.chat.id;
    const text   = message.text.trim();
    const prenom = message.from?.first_name ?? undefined;

    await typing(chatId);

    // 1. Réponses instantanées (sans Groq, sans quota)
    const instant = reponseInstantanee(text, prenom);
    if (instant) {
      await send(chatId, instant);
      return new Response('OK');
    }

    // 2. Charger les pronostics
    const { donnees, count, matchsResume } = await chargerPronostics();

    // 3. Commande /pronostics — affichage direct formaté
    if (/^\/pronostics/.test(text.toLowerCase())) {
      if (!count) {
        await send(chatId,
          `Pas de matchs analysés pour cette semaine pour l'instant...\n\nLes données sont mises à jour chaque nuit — reviens demain matin, j'aurai du nouveau 🌙`
        );
      } else {
        await send(chatId, `Voilà mes pronos de la semaine :\n${matchsResume}`);
      }
      return new Response('OK');
    }

    // 4. Pas de données mais question posée
    if (!count) {
      await send(chatId,
        `Honnêtement, j'ai pas de matchs analysés cette semaine pour l'instant.\n\nLes crons tournent chaque nuit — reviens demain et j'aurai mes analyses fraîches 🌙`
      );
      return new Response('OK');
    }

    // 5. Consommer quota Groq
    const groqOk = await consommerGroq();
    if (!groqOk) {
      // Fallback direct si quota épuisé
      await send(chatId, `J'ai beaucoup travaillé aujourd'hui, je recharge 😅\n\nVoilà direct mes pronos :\n${matchsResume}`);
      return new Response('OK');
    }

    // 6. Réponse Groq conversationnelle
    const reponse = await groqReponse(text, donnees, prenom);
    await send(chatId, reponse);

    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
