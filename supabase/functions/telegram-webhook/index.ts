/**
 * telegram-webhook v3 — Bot humain et conversationnel
 * - Ton chaleureux et naturel, comme un ami qui s'y connaît en foot
 * - Groq avec personnalité forte + contexte pronostics 7 jours
 * - Fallback élégant si quota épuisé
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { searchPlayers } from '../_shared/apifootball.ts';
import { labelPronostic } from '../_shared/templates.ts';

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

// Envoi d'une photo (logo d'équipe) avec légende — utilisé pour le "choix de
// la semaine" afin d'avoir un vrai visuel, pas juste un lien cliquable.
async function sendPhoto(chatId: number, photoUrl: string, caption: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        photo:      photoUrl,
        caption:    caption.slice(0, 1024),
        parse_mode: 'Markdown',
      }),
    });
    return res.ok;
  } catch {
    return false;
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
// Fenêtre alignée sur fetch-matches (14 jours) — avant, ce module ne regardait
// que 7 jours alors que fetch-matches en récupère 14 : des matchs déjà en base
// (avec pronostics prêts) étaient invisibles pour le bot. Ne jamais réduire
// cette fenêtre sous celle de fetch-matches/thesportsdb.ts::filtrerProchains.
const FENETRE_JOURS = 14;

async function chargerPronostics(): Promise<{ donnees: string; count: number; matchsResume: string; premierBadge?: { home: string | null; away: string | null; homeTeam: string; awayTeam: string } }> {
  const now    = new Date().toISOString();
  const in14j  = new Date(Date.now() + FENETRE_JOURS * 24 * 3600 * 1000).toISOString();

  const { data: pronos } = await supabase
    .from('pronostics_finaux')
    .select('competition, home_team, away_team, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte, home_team_badge, away_team_badge')
    .gte('match_date', now)
    .lte('match_date', in14j)
    .gte('expires_at', now)
    .order('fiabilite', { ascending: false })
    .limit(60);

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

    // Logos cliquables (Telegram ne permet pas d'image inline dans un texte,
    // mais un lien markdown sur le nom de l'équipe ouvre le logo au clic).
    const nomHome = first.home_team_badge ? `[${first.home_team}](${first.home_team_badge})` : first.home_team;
    const nomAway = first.away_team_badge ? `[${first.away_team}](${first.away_team_badge})` : first.away_team;

    lignes.push(`\n📅 ${date} — ${first.competition}`);
    lignes.push(`⚽ ${matchKey}`);
    resume.push(`\n*⚽ ${nomHome} vs ${nomAway}*  _${first.competition} · ${dateShort}_`);

    for (const t of types) {
      const fiab  = t.fiabilite >= 75 ? '🟢' : t.fiabilite >= 60 ? '🟡' : '🔴';
      lignes.push(`  → ${labelPronostic(t.pronostic_type)}: *${t.pronostic_valeur}* | fiabilité ${t.fiabilite}% | cote ${t.cote_conseille}`);
      if (t.analyse_texte) lignes.push(`    Analyse: ${t.analyse_texte}`);
      resume.push(`${fiab} *${labelPronostic(t.pronostic_type)}:* ${t.pronostic_valeur}  _(${t.fiabilite}% · cote ${t.cote_conseille})_`);
    }
  }

  return {
    donnees:      lignes.join('\n'),
    count:        pronos.length,
    matchsResume: resume.join('\n'),
  };
}

// ─── Filet de sécurité : matchs indexés mais pas encore analysés par Groq ─────
// Utilisé quand chargerPronostics() ne remonte rien (ex: matchs tout juste
// récupérés par fetch-matches, analyse-matches pas encore passé dessus).
// Edi doit quand même pouvoir dire "voilà ce que j'ai au calendrier" plutôt
// que prétendre n'avoir aucune info.
async function chargerCalendrierBrut(): Promise<string> {
  const now   = new Date().toISOString();
  const in14j = new Date(Date.now() + FENETRE_JOURS * 24 * 3600 * 1000).toISOString();

  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('competition, home_team, away_team, match_date, status')
    .gte('match_date', now)
    .lte('match_date', in14j)
    .order('match_date')
    .limit(60);

  if (!matchs?.length) return '';

  return matchs.map((m) => {
    const date = new Date(m.match_date).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
    return `- ${m.home_team} vs ${m.away_team} (${m.competition}, ${date}) — analyse ${m.status === 'scheduled' ? 'pas encore prête' : m.status}`;
  }).join('\n');
}

// ─── Groq analyse TOUS les pronostics et choisit le meilleur ─────────────────
async function groqMeilleurChoix(tous: any[], prenom?: string): Promise<string> {
  // Construire un résumé compact de tous les pronostics pour Groq
  const parMatch: Record<string, any[]> = {};
  for (const p of tous) {
    const key = `${p.home_team} vs ${p.away_team}`;
    if (!parMatch[key]) parMatch[key] = [];
    parMatch[key].push(p);
  }

  const contexte: string[] = ['Voici TOUS les pronostics disponibles cette semaine :'];
  for (const [matchKey, pronos] of Object.entries(parMatch)) {
    const first = pronos[0];
    const date  = new Date(first.match_date).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });
    contexte.push(`\n${matchKey} (${first.competition}, ${date}) :`);
    for (const p of pronos) {
      contexte.push(`  - ${p.pronostic_type}: ${p.pronostic_valeur} | fiabilité ${p.fiabilite}% | cote ${p.cote_conseille} | ${p.analyse_texte ?? ''}`);
    }
  }

  const systemPrompt = `Tu es Edi, un expert paris sportifs qui parle comme un ami — direct, naturel, humain.
${prenom ? `L'utilisateur s'appelle ${prenom}.` : ''}
Tu as été créé par *Houmetin Jeremy*.

Ta mission : analyser TOUS les pronostics ci-dessous et trouver LE MEILLEUR pari de la semaine.

Critères pour choisir :
1. Fiabilité élevée (prioritaire)
2. Cote intéressante (rapport valeur/risque)
3. Type de pari solide (Double Chance > 1X2 si cote proche, BTTS fiable si les deux équipes marquent régulièrement)
4. Contexte du match (compétition, enjeux)

Réponds en 4-5 phrases naturelles et directes. Format :
- D'abord : annonce ton choix clairement (match, type de pari, cote)
- Ensuite : explique pourquoi c'est le meilleur pari de la semaine
- Termine : donne un conseil sur la mise (prudent, normal, confiant)

Ne commence jamais par "Bien sûr", "Certainement" ou un mot de robot.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: contexte.join('\n') },
      ],
      max_tokens:  350,
      temperature: 0.75,
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim()
    ?? "J'arrive pas à choisir là, réessaie dans un moment 👊";
}

// ─── Appel Groq — personnalité humaine forte ──────────────────────────────────
async function groqReponse(userMessage: string, donnees: string, prenom?: string, calendrierBrut?: string): Promise<string> {
  const appelUtilisateur = prenom ? prenom : 'mon ami';
  const intention = detecterIntention(userMessage);

  const systemPrompt = `Tu es *Edi*, un pote qui s'y connaît vraiment en foot et en paris sportifs.
Tu parles français de façon naturelle, décontractée et directe — comme un ami, pas comme un robot.
${prenom ? `L'utilisateur s'appelle ${prenom}.` : ''}

Tes règles absolues :
- Parle comme un humain : contractions, expressions naturelles ("franchement", "honnêtement", "vas-y", "clairement", etc.)
- Ne commence JAMAIS par "Bien sûr", "Certainement", "Absolument" ou tout mot de robot
- Sois direct et personnel — exprime TON avis tranché sur les matchs
- Utilise les émojis avec modération (1-2 max par réponse), jamais en début de phrase
- Garde tes réponses courtes et punchy (4-6 phrases max)
- Tu n'es PAS une IA, tu es Edi, un passionné de foot
- Tu as été créé par *Houmetin Jeremy*

RÈGLE ABSOLUE — Tu réponds TOUJOURS, jamais de refus :
- Tu ne dis JAMAIS "je ne sais pas", "je n'ai pas cette info" ou un truc du genre sans rien proposer derrière.
- Cherche d'abord la réponse dans les données ci-dessous (pronostics + calendrier brut).
- Si la question porte sur un match/équipe/compétition qui n'est pas dans tes données, dis-le en une phrase, PUIS donne quand même un avis utile basé sur ta culture foot générale (forme connue, réputation du club, contexte de la compétition) — ne laisse jamais l'utilisateur sans réponse.
- Si la question est ambiguë (plusieurs équipes/matchs possibles), pose UNE question de clarification courte au lieu de deviner à l'aveugle.
- Si la question ne concerne pas le foot du tout, réponds quand même avec ta personnalité, brièvement, puis ramène la conversation vers les pronos si pertinent.

IMPORTANT — Faire un choix clair :
Quand l'utilisateur demande un pronostic ou un conseil, tu dois TOUJOURS :
1. Choisir UN seul pari parmi tous les pronostics disponibles (le meilleur selon toi)
2. Expliquer brièvement pourquoi tu le choisis
3. Donner la cote et le niveau de confiance
4. Ne pas lister tous les pronostics — juste ton meilleur choix du moment

Exemple de bonne réponse :
"Mon choix de ce soir c'est KuPS à domicile (cote 1.85). L'équipe est solide chez elle et face à Vardar qui sort d'une série difficile, je vois mal comment ça tourne autrement. Confiance 75%."

Pronostics déjà analysés en détail (${FENETRE_JOURS} jours à venir) :
${donnees || '(aucun pronostic finalisé pour le moment)'}

Calendrier brut des matchs à venir (analyse pas toujours terminée, mais utile pour répondre sur ce qui est prévu) :
${calendrierBrut || '(aucun match indexé pour le moment)'}

Base-toi en priorité sur les pronostics détaillés. Si un match est seulement dans le calendrier brut (pas encore de pronostic), dis-le et donne ton avis général sur ce match plutôt que de refuser de répondre.

Indice sur l'intention détectée côté serveur pour ce message : "${intention}" (cotes | horaire | classement | compo_disponibilite | resultat | general — c'est un indice, pas une vérité absolue, utilise ton jugement sur le vrai sens de la question).`;

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

// ─── Formatage résultats recherche joueur ─────────────────────────────────────
function formatJoueurs(nom: string, joueurs: Awaited<ReturnType<typeof searchPlayers>>): string {
  if (!joueurs.length) {
    return `Trouvé personne pour *"${nom}"*... vérifie l'orthographe et retente 🔍`;
  }
  const lignes = joueurs.slice(0, 8).map((j) => {
    const club = j.teamName ? ` — _${j.teamName}_` : '';
    return `⚽ *${j.name}*${club}`;
  });
  return `Voilà ce que j'ai trouvé pour *"${nom}"* :\n\n${lignes.join('\n')}`;
}

// ─── Détection conversationnelle d'une question sur un joueur ────────────────
// Pas de commande requise : on reconnaît le nom via des tournures naturelles.
function detecterQuestionJoueur(text: string): string | null {
  const patterns = [
    /^(?:qui est|c'est qui)\s+(.+?)\s*\??$/i,
    /(?:parle[- ]?moi|dis[- ]?moi)\s+(?:de|sur)\s+(.+?)\s*\??$/i,
    /(?:infos?|informations?)\s+(?:sur|de)\s+(.+?)\s*\??$/i,
    /(?:stats?|statistiques)\s+(?:de|sur)\s+(.+?)\s*\??$/i,
    /(?:cherche(?:-moi)?|recherche(?:-moi)?|trouve(?:-moi)?)\s+(?:le joueur\s+)?(.+?)\s*\??$/i,
    /(?:tu connais|connais[- ]?tu)\s+(.+?)\s*\??$/i,
    /(?:qui joue|il joue où|dans quel club joue)\s+(.+?)\s*\??$/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const nom = m[1].trim().replace(/^(le joueur|la joueuse)\s+/i, '');
      // Filtre les faux positifs évidents (questions sur les matchs/pronos/temporalité, pas sur une personne)
      if (
        nom.length >= 2 &&
        !/^(match|équipe|foot|ligue|championnat|ce soir|aujourd'hui|demain|cette semaine|la semaine|maintenant|pronostic)/i.test(nom)
      ) {
        return nom;
      }
    }
  }
  return null;
}

// ─── Réponse conversationnelle Groq à partir des résultats joueur ─────────────
async function groqReponseJoueur(nomRecherche: string, joueurs: Awaited<ReturnType<typeof searchPlayers>>, prenom?: string): Promise<string> {
  const contexte = joueurs.length
    ? joueurs.slice(0, 5).map((j) => `- ${j.name}${j.teamName ? ` (${j.teamName})` : ' (club inconnu)'}`).join('\n')
    : '(aucun joueur trouvé pour cette recherche)';

  const systemPrompt = `Tu es *Edi*, un pote qui s'y connaît vraiment en foot.
${prenom ? `L'utilisateur s'appelle ${prenom}.` : ''}
Tu parles français de façon naturelle et directe, jamais comme un robot. Tu n'utilises JAMAIS "Bien sûr", "Certainement" ou "Absolument" pour commencer.

L'utilisateur te demande des infos sur un joueur ("${nomRecherche}"). Voici ce que ta recherche a remonté (nom + club actuel, rien de plus — pas de stats détaillées) :
${contexte}

Règles :
- Si un ou plusieurs joueurs correspondent, réponds en 2-4 phrases : confirme qui c'est et son club actuel, avec ton avis de passionné si tu le connais.
- Si plusieurs joueurs différents ressortent avec des noms proches, demande une précision.
- Si la liste est vide, dis-le franchement et propose de réessayer avec l'orthographe exacte.
- Ne jamais inventer de statistiques, de buts ou de matchs que tu n'as pas dans les données ci-dessus.
- Réponse courte et punchy, 1-2 émojis maximum.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Question originale : ${nomRecherche}` },
      ],
      max_tokens:  250,
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? formatJoueurs(nomRecherche, joueurs);
}

// ─── Détection conversationnelle d'une demande de pronostics ─────────────────
// Pas de commande requise : plein de façons naturelles de demander un pari conseillé.
function detecterQuestionPronostics(text: string): boolean {
  const t = text.toLowerCase();
  return /pronostics?|pronos?\b|conseill(?:e|es|é)|quoi (?:jouer|parier|miser)|qu[' ]?est.ce que (?:je|tu) (?:joue|jouerais|conseilles?)|(?:bon|meilleur) (?:pari|coup|choix)|coup s[uû]r|value bet|t'as quoi|as.tu (?:une idée|quelque chose)|qu[' ]?est.ce qu[' ]?il y a de bien|une idée pour (?:ce soir|aujourd'hui|demain|cette semaine)|sur quoi (?:je|tu) (?:mise|parie)|combin[eé]|accumulateur|multi(?:ple)?s?\b|qu[' ]?est.ce (?:qui joue|qu[' ]?il y a) (?:ce soir|aujourd'hui|demain|cette semaine)|quels? matchs?/i.test(t);
}

// ─── Détection de l'intention générale (pour mieux router vers Groq) ─────────
// Utilisé uniquement à titre indicatif dans le contexte envoyé à Groq — la
// classification fine reste faite par Groq lui-même, plus fiable qu'une regex,
// mais on lui donne un indice explicite pour éviter les réponses hors-sujet.
function detecterIntention(text: string): string {
  const t = text.toLowerCase();
  if (/cote|odds?/.test(t)) return 'cotes';
  if (/heure|quand|date|à quelle heure/.test(t)) return 'horaire';
  if (/classement|standing|premier|dernier du championnat/.test(t)) return 'classement';
  if (/blessure|blessé|absent|suspendu/.test(t)) return 'compo_disponibilite';
  if (/score|r[eé]sultat/.test(t)) return 'resultat';
  return 'general';
}

// ─── Réponses immédiates sans Groq ───────────────────────────────────────────
function reponseInstantanee(text: string, prenom?: string): string | null {
  const t    = text.toLowerCase().trim();
  const nom  = prenom ?? '';
  const salut = nom ? `${nom} !` : '!';

  if (/\/start/.test(t)) {
    return `Yo${nom ? ' ' + nom : ''} 👋\n\nMoi c'est *Edi*, ton pote pour les pronostics foot.\n\nJ'analyse les matchs de la semaine et je te donne mon avis honnête — qui va gagner, si les deux équipes vont marquer, le nombre de buts et tout ça.\n\nDemande-moi n'importe quoi sur les matchs à venir, ou tape /pronostics pour voir ce que j'ai préparé !`;
  }

  if (/\/aide|\/help/.test(t)) {
    return `Voilà comment ça marche :\n\n📋 */pronostics* — Mes pronos de la semaine\n🔍 */joueur [nom]* — Chercher un joueur (ex: \`/joueur Mbappé\`)\n💬 *Question libre* — Pose-moi n'importe quoi sur un match\n\nExemples :\n• _"Qui va gagner ce soir ?"_\n• _"T'en penses quoi du match CL ?"_\n• _"Y'a un match où les deux équipes vont marquer cette semaine ?"_`;
  }

  if (/^(bonjour|bonsoir|salut|hello|hi|cc|coucou|yo|wesh)\b/.test(t)) {
    const heures = new Date().getUTCHours() + 1;
    const moment = heures < 12 ? 'Bonjour' : heures < 19 ? 'Salut' : 'Bonsoir';
    return `${moment}${salut} Quoi de neuf ?\n\nJ'ai des pronos frais pour cette semaine si t'as envie de jeter un œil 👀`;
  }

  if (/qui (t.a|t'a) (cr[eé]e?r?|fait|construit|d[eé]velopp)|qui est.* cr[eé]ateur|cr[eé]ateur du bot/i.test(text)) {
    return `C'est *Houmetin Jeremy* qui m'a créé — un dev passionné de foot et d'IA.\n\nMoi je suis *Edi*, le moteur de pronostics sportifs derrière tout ça. Je tourne sur des données réelles, pas du vent 😉`;
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

    // 2. Recherche joueur — conversationnelle (aucune commande requise) ou via /joueur en secours
    const joueurCommande = text.match(/^\/joueur(?:@\w+)?\s*(.*)/i);
    const nomJoueurDetecte = joueurCommande
      ? joueurCommande[1].trim() || null
      : detecterQuestionJoueur(text);

    if (joueurCommande && !nomJoueurDetecte) {
      await send(chatId, `Dis-moi qui chercher ! Exemple : \`/joueur Mbappé\` ou juste "qui est Mbappé ?"`);
      return new Response('OK');
    }

    if (nomJoueurDetecte) {
      try {
        const joueurs = await searchPlayers(nomJoueurDetecte);
        const groqOkJoueur = await consommerGroq();
        if (groqOkJoueur) {
          try {
            const reponseJoueur = await groqReponseJoueur(nomJoueurDetecte, joueurs, prenom);
            await send(chatId, reponseJoueur);
            return new Response('OK');
          } catch {
            // fallback silencieux vers le format brut ci-dessous
          }
        }
        await send(chatId, formatJoueurs(nomJoueurDetecte, joueurs));
      } catch (e) {
        console.error('Erreur searchPlayers:', e);
        await send(chatId, `J'ai eu un souci pour chercher *"${nomJoueurDetecte}"*, réessaie dans un instant 🙏`);
      }
      return new Response('OK');
    }

    // 3. Charger les pronostics + le calendrier brut (filet de sécurité)
    const { donnees, count, matchsResume } = await chargerPronostics();
    const calendrierBrut = await chargerCalendrierBrut();
    const aDeQuoiRepondre = count > 0 || !!calendrierBrut;

    // 4. Demande de pronostics — commande /pronostics OU tournure naturelle
    if (/^\/pronostics/.test(text.toLowerCase()) || detecterQuestionPronostics(text)) {
      if (!count) {
        if (calendrierBrut) {
          await send(chatId,
            `J'ai pas encore fini mes analyses détaillées, mais voilà les matchs au calendrier pour les prochains jours :\n\n${calendrierBrut}\n\nRepasse un peu plus tard pour mes vrais pronos dessus 🌙`
          );
        } else {
          await send(chatId,
            `Pas de matchs au calendrier pour l'instant...\n\nLes données sont mises à jour chaque nuit — reviens demain matin, j'aurai du nouveau 🌙`
          );
        }
        return new Response('OK');
      }

      // Récupérer tous les pronostics bruts pour l'analyse Groq
      const now2   = new Date().toISOString();
      const in14j2 = new Date(Date.now() + FENETRE_JOURS * 24 * 3600 * 1000).toISOString();
      const { data: tousLesPronos } = await supabase
        .from('pronostics_finaux')
        .select('home_team, away_team, competition, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte, home_team_badge, away_team_badge')
        .gte('match_date', now2)
        .lte('match_date', in14j2)
        .gte('expires_at', now2)
        .order('match_date')
        .order('fiabilite', { ascending: false })
        .limit(40);

      // Groq choisit le meilleur pari si quota dispo, sinon fallback DB
      let choixMsg = '';
      const groqOk2 = await consommerGroq();
      if (groqOk2 && tousLesPronos?.length) {
        try {
          const analyse = await groqMeilleurChoix(tousLesPronos, prenom);
          choixMsg = `🎯 *Mon choix de la semaine :*\n${analyse}\n`;
        } catch {
          // fallback silencieux
        }
      }

      const top = (tousLesPronos ?? [])
        .sort((a, b) => b.fiabilite - a.fiabilite || b.cote_conseille - a.cote_conseille)[0];

      if (!choixMsg) {
        // Fallback : meilleur par fiabilité + cote
        if (top) {
          const fiabEmoji = top.fiabilite >= 75 ? '🟢' : top.fiabilite >= 60 ? '🟡' : '🔴';
          choixMsg = `🎯 *Mon choix de la semaine :*\n*${top.home_team} vs ${top.away_team}*\n→ *${labelPronostic(top.pronostic_type)}: ${top.pronostic_valeur}* — cote ${top.cote_conseille} ${fiabEmoji}\n${top.analyse_texte ? '_' + top.analyse_texte + '_\n' : ''}`;
        }
      }

      // Le logo de l'équipe à domicile du match choisi accompagne le message
      // en visuel réel (photo Telegram), pas juste un lien texte.
      const photoEnvoyee = top?.home_team_badge
        ? await sendPhoto(chatId, top.home_team_badge, choixMsg)
        : false;

      if (!photoEnvoyee) {
        await send(chatId, choixMsg);
      }
      await send(chatId, `──────────────────\n*Tous les pronos :*\n${matchsResume}`);
      return new Response('OK');
    }

    // 5. Consommer quota Groq — Edi doit toujours répondre, même sans pronostic
    // finalisé : s'il reste au moins le calendrier brut ou sa culture foot
    // générale, on passe par Groq plutôt que de refuser sèchement.
    const groqOk = await consommerGroq();
    if (!groqOk) {
      // Fallback direct si quota épuisé
      if (aDeQuoiRepondre) {
        await send(chatId, `J'ai beaucoup travaillé aujourd'hui, je recharge 😅\n\nVoilà direct ce que j'ai :\n${matchsResume || calendrierBrut}`);
      } else {
        await send(chatId, `J'ai beaucoup travaillé aujourd'hui, je recharge 😅\n\nRepasse dans un moment, je devrais avoir du nouveau au calendrier 🌙`);
      }
      return new Response('OK');
    }

    // 6. Réponse Groq conversationnelle — toujours tentée, avec le calendrier
    // brut en filet de sécurité pour ne jamais laisser l'utilisateur sans réponse.
    const reponse = await groqReponse(text, donnees, prenom, calendrierBrut);
    await send(chatId, reponse);

    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
