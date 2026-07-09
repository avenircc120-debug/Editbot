/**
 * telegram-webhook v2 — Bot conversationnel
 * Fix: vérifie les données AVANT de consommer le quota Groq
 * Fix: répond aux questions simples sans Groq
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY       = Deno.env.get('GROQ_API_KEY') ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama3-70b-8192';

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

// ─── Charger les pronostics depuis la base ────────────────────────────────────
async function chargerPronostics(): Promise<{ donnees: string; count: number }> {
  const now   = new Date().toISOString();
  const in72h = new Date(Date.now() + 72 * 3600 * 1000).toISOString();

  // Le bot ne lit QUE pronostics_finaux — table de consultation "prête à servir".
  // Aucun calcul ni JOIN en direct : réponse en quelques millisecondes.
  const { data: pronos } = await supabase
    .from('pronostics_finaux')
    .select('competition, home_team, away_team, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte')
    .gte('match_date', now)
    .lte('match_date', in72h)
    .gte('expires_at', now)
    .order('fiabilite', { ascending: false })
    .limit(20);

  if (!pronos?.length) {
    return { donnees: '', count: 0 };
  }

  // Grouper par match
  const parMatch: Record<string, any[]> = {};
  for (const p of pronos) {
    const key = `${p.home_team} vs ${p.away_team}`;
    if (!parMatch[key]) parMatch[key] = [];
    parMatch[key].push(p);
  }

  const lignes: string[] = [];
  for (const [matchKey, types] of Object.entries(parMatch)) {
    const first = types[0];
    const date  = new Date(first.match_date).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
    lignes.push(`\nMATCH: ${matchKey} | ${first.competition} | ${date}`);
    for (const t of types) {
      lignes.push(`  ${t.pronostic_type}: ${t.pronostic_valeur} (fiabilité ${t.fiabilite}%, cote ${t.cote_conseille})`);
      if (t.analyse_texte) lignes.push(`  Analyse: ${t.analyse_texte}`);
    }
  }

  return { donnees: lignes.join('\n'), count: pronos.length };
}

// ─── Appel Groq conversationnel ───────────────────────────────────────────────
async function groqReponse(userMessage: string, donnees: string): Promise<string> {
  const systemPrompt = `Tu es un assistant spécialisé en pronostics sportifs football, chaleureux et professionnel.
Tu réponds UNIQUEMENT en français.
Tu as accès aux données suivantes sur les matchs à venir :

${donnees}

Si l'utilisateur pose une question sur un match ou un pronostic, base-toi uniquement sur ces données.
Si l'utilisateur te parle de toi-même ou te pose une question générale, réponds naturellement sans mentionner les données.
Sois concis (3-5 phrases max). Pas de listes à puces excessives.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      max_tokens:  500,
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? 'Désolé, je ne peux pas répondre pour le moment.';
}

// ─── Réponse fallback (liste directe des pronostics) ─────────────────────────
async function reponseFallback(chatId: number) {
  const { donnees, count } = await chargerPronostics();

  if (!count) {
    return send(chatId,
      '⚽ *Editbot* — Moteur de pronostics sportifs\n\n' +
      'Aucun pronostic disponible pour le moment.\n' +
      'Les données sont mises à jour chaque nuit automatiquement.\n\n' +
      '_Revenez demain pour des pronostics frais !_'
    );
  }

  const lignes = donnees.split('\n').filter(Boolean);
  return send(chatId, `⚽ *Pronostics disponibles*\n\n${lignes.join('\n')}`);
}

// ─── Détection de questions simples (sans besoin de quota Groq) ──────────────
function estQuestionSimple(text: string): string | null {
  const t = text.toLowerCase();
  if (t.match(/qui (t.a|t'a) (cr[eé]e?r?|fait|d[eé]velopp)/i))
    return "👨‍💻 J'ai été créé par *Avenir CC*, un développeur passionné de sport et d'IA.\n\nJe suis *Editbot*, un moteur de pronostics sportifs basé sur l'intelligence artificielle. J'analyse les données en temps réel pour vous proposer les meilleures prédictions de football. ⚽";
  if (t.match(/^(bonjour|bonsoir|salut|hello|hi|cc|coucou|yo)\b/i))
    return "👋 Bonjour ! Je suis *Editbot*, votre assistant de pronostics sportifs.\n\nEnvoyez-moi *n'importe quelle question* sur les matchs à venir et je vous donnerai des analyses basées sur des données réelles. ⚽";
  if (t.match(/\/start/i))
    return "⚽ *Bienvenue sur Editbot !*\n\nJe suis votre expert en pronostics sportifs alimenté par l'IA.\n\n*Ce que je peux faire :*\n• Analyser les matchs à venir\n• Donner des pronostics 1X2, BTTS, Over/Under\n• Expliquer mes analyses\n\nPosez-moi n'importe quelle question sur le football !";
  if (t.match(/\/aide|\/help/i))
    return "📋 *Aide — Editbot*\n\n• `/pronostics` — Voir les pronostics du jour\n• Posez votre question en français naturel\n• Ex: _Qui va gagner ce soir ?_\n• Ex: _Que penses-tu du match PSG-OL ?_";
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

    await typing(chatId);

    // 1. Réponses immédiates sans Groq (questions simples)
    const reponseSimple = estQuestionSimple(text);
    if (reponseSimple) {
      await send(chatId, reponseSimple);
      return new Response('OK');
    }

    // 2. Charger les pronostics d'abord (AVANT de consommer quota Groq)
    const { donnees, count } = await chargerPronostics();

    // 3. Commandes /pronostics — réponse directe sans Groq
    if (text.toLowerCase().startsWith('/pronostics')) {
      if (!count) {
        await send(chatId,
          '⚽ Aucun pronostic disponible pour les prochaines 72h.\n' +
          '_Les données sont mises à jour chaque nuit._'
        );
      } else {
        await send(chatId, `⚽ *Pronostics du moment*\n${donnees}`);
      }
      return new Response('OK');
    }

    // 4. Si aucun pronostic disponible → pas besoin d'appeler Groq
    if (!count) {
      await send(chatId,
        '⚽ Aucun pronostic disponible pour les prochaines 72h.\n\n' +
        'Les données sont récupérées chaque nuit depuis SofaScore et analysées par IA.\n' +
        '_Revenez demain pour des pronostics à jour !_'
      );
      return new Response('OK');
    }

    // 5. Consommer quota Groq seulement si on a des données
    const groqOk = await consommerGroq();
    if (!groqOk) {
      // Fallback : liste directe des pronostics sans Groq
      await send(chatId, `⚽ *Pronostics disponibles*\n${donnees}`);
      return new Response('OK');
    }

    // 6. Réponse Groq conversationnelle avec contexte
    const userMessage = text;
    const reponse     = await groqReponse(userMessage, donnees);
    await send(chatId, reponse);

    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
