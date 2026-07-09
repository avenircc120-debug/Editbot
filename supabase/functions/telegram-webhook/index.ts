/**
 * telegram-webhook — Bot conversationnel
 *
 * L'utilisateur pose n'importe quelle question en langage naturel.
 * Le bot charge les pronostics disponibles et demande à Groq de
 * formuler une réponse naturelle en français.
 *
 * Fallback sans Groq (quota épuisé) : réponse template directe.
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
  return data !== false; // true = autorisé, false = épuisé
}

// ─── Envoi Telegram ───────────────────────────────────────────────────────────
async function send(chatId: number, text: string) {
  // Telegram : max 4096 chars par message
  const chunks = text.match(/.{1,4000}(\s|$)/gs) ?? [text];
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
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

// Indicateur "en train d'écrire..."
async function typing(chatId: number) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  });
}

// ─── Charger les données depuis la base ───────────────────────────────────────
async function chargerDonnees(): Promise<string> {
  const in72h = new Date(Date.now() + 72 * 3600 * 1000).toISOString();

  // Pronostics disponibles dans les prochaines 72h
  const { data: pronos } = await supabase
    .from('pronostics_pre_calcules')
    .select('competition, home_team, away_team, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in72h)
    .gte('expires_at', new Date().toISOString())
    .order('fiabilite', { ascending: false })
    .limit(20);

  if (!pronos?.length) {
    return 'Aucun pronostic en base pour les prochaines 72h. Les données sont mises à jour chaque nuit.';
  }

  // Grouper par match pour éviter la redondance
  const parMatch: Record<string, any[]> = {};
  for (const p of pronos) {
    const key = `${p.home_team} vs ${p.away_team}`;
    if (!parMatch[key]) parMatch[key] = [];
    parMatch[key].push(p);
  }

  const lignes: string[] = [];
  for (const [match, types] of Object.entries(parMatch)) {
    const first = types[0];
    const date  = new Date(first.match_date).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
    lignes.push(`\nMATCH: ${match} | ${first.competition} | ${date}`);
    for (const t of types) {
      lignes.push(`  ${t.pronostic_type}: ${t.pronostic_valeur} (fiabilité ${t.fiabilite}%, cote ${t.cote_conseille})`);
      if (t.analyse_texte) lignes.push(`  Analyse: ${t.analyse_texte}`);
    }
  }

  return lignes.join('\n');
}

// ─── Appel Groq conversationnel ───────────────────────────────────────────────
async function groqReponse(userMessage: string, donnees: string): Promise<string> {
  const systemPrompt = `Tu es un assistant expert en pronostics sportifs sur Telegram. Tu réponds aux questions des utilisateurs en français de façon naturelle, directe et chaleureuse.

Règles :
- Utilise UNIQUEMENT les données fournies, n'invente rien.
- Si une question concerne une compétition spécifique (Ligue 1, Premier League, etc.), filtre les données en conséquence.
- Si on demande "les matchs de ce soir" ou "aujourd'hui", filtre par date.
- Réponds de façon concise mais complète (max 10 lignes sur Telegram).
- Utilise des emojis pertinents (⚽ 🏆 📊 🎯 etc.) pour rendre le message agréable.
- Si les données sont vides, dis-le honnêtement et explique que les données sont mises à jour chaque nuit.
- N'utilise JAMAIS de syntaxe de commandes comme /pronostics. Tu réponds toujours naturellement.
- Formate bien pour Telegram : *gras* pour les noms d'équipes, \`code\` pour les cotes.
- Si la question est hors sujet (pas de foot/sport), réponds brièvement et redirige vers les pronostics.`;

  const userContent = `Question de l'utilisateur : "${userMessage}"

Données disponibles :
${donnees}`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
      max_tokens:  600,
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices[0]?.message?.content?.trim() ?? 'Je n\'ai pas pu générer une réponse.';
}

// ─── Réponse de secours (sans Groq) ──────────────────────────────────────────
async function reponseFallback(chatId: number) {
  const in72h = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('pronostics_pre_calcules')
    .select('competition, home_team, away_team, match_date, pronostic_valeur, fiabilite')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in72h)
    .gte('expires_at', new Date().toISOString())
    .order('fiabilite', { ascending: false })
    .limit(5);

  if (!data?.length) {
    return send(chatId, '📭 Aucun pronostic disponible pour le moment. Revenez demain, les données sont mises à jour chaque nuit !');
  }

  const lignes = data.map(p => {
    const e = p.fiabilite >= 80 ? '🟢' : p.fiabilite >= 65 ? '🟡' : '🔴';
    const d = new Date(p.match_date).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Paris' });
    return `${e} *${p.home_team}* vs *${p.away_team}*\n   ${p.competition} · ${d} · ${p.pronostic_valeur} (${p.fiabilite}%)`;
  }).join('\n\n');

  return send(chatId, `⚽ *Pronostics disponibles*\n\n${lignes}`);
}

// ─── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK');

  try {
    const body    = await req.json();
    const message = body.message ?? body.edited_message;

    // Ignorer les messages sans texte (photos, stickers, etc.)
    if (!message?.text) return new Response('OK');

    const chatId = message.chat.id;
    const text   = message.text.trim();

    // Ignorer les commandes système Telegram (ex: /setdescription, /start sans contexte)
    // Traiter /start comme une question naturelle de bienvenue
    const isStart = text.toLowerCase().startsWith('/start');
    const userMessage = isStart
      ? 'Bonjour ! Présente-toi et dis-moi ce que tu peux faire pour moi.'
      : text;

    // Afficher "en train d'écrire..." pendant le traitement
    await typing(chatId);

    // Vérifier le quota Groq
    const groqOk = await consommerGroq();

    if (!groqOk) {
      // Quota épuisé → réponse template directe
      await reponseFallback(chatId);
      return new Response('OK');
    }

    // Charger les données et générer une réponse naturelle
    const donnees  = await chargerDonnees();
    const reponse  = await groqReponse(userMessage, donnees);
    await send(chatId, reponse);

    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
