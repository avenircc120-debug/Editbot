/**
 * telegram-webhook v3 — Bot humain et conversationnel
 * - Ton chaleureux et naturel, comme un ami qui s'y connaît en foot
 * - Groq avec personnalité forte + contexte pronostics 7 jours
 * - Fallback élégant si quota épuisé
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { searchPlayers } from '../_shared/apifootball.ts';

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
async function groqReponse(userMessage: string, donnees: string, prenom?: string): Promise<string> {
  const appelUtilisateur = prenom ? prenom : 'mon ami';

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

IMPORTANT — Faire un choix clair :
Quand l'utilisateur demande un pronostic ou un conseil, tu dois TOUJOURS :
1. Choisir UN seul pari parmi tous les pronostics disponibles (le meilleur selon toi)
2. Expliquer brièvement pourquoi tu le choisis
3. Donner la cote et le niveau de confiance
4. Ne pas lister tous les pronostics — juste ton meilleur choix du moment

Exemple de bonne réponse :
"Mon choix de ce soir c'est KuPS à domicile (cote 1.85). L'équipe est solide chez elle et face à Vardar qui sort d'une série difficile, je vois mal comment ça tourne autrement. Confiance 75%."

Données pronostics disponibles (7 jours à venir) :
${donnees || '(aucun match disponible cette semaine)'}

Si l'utilisateur pose une question sur un match spécifique, base-toi sur ces données.
Si aucune donnée n'est disponible, dis-le directement.`;

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

// ─── Réponses immédiates sans Groq ───────────────────────────────────────────
function reponseInstantanee(text: string, prenom?: string): string | null {
  const t    = text.toLowerCase().trim();
  const nom  = prenom ?? '';
  const salut = nom ? `${nom} !` : '!';

  if (/\/start/.test(t)) {
    return `Yo${nom ? ' ' + nom : ''} 👋\n\nMoi c'est *Edi*, ton pote pour les pronostics foot.\n\nJ'analyse les matchs de la semaine et je te donne mon avis honnête — 1X2, BTTS, Over/Under et tout ça.\n\nDemande-moi n'importe quoi sur les matchs à venir, ou tape /pronostics pour voir ce que j'ai préparé !`;
  }

  if (/\/aide|\/help/.test(t)) {
    return `Voilà comment ça marche :\n\n📋 */pronostics* — Mes pronos de la semaine\n🔍 */joueur [nom]* — Chercher un joueur (ex: \`/joueur Mbappé\`)\n💬 *Question libre* — Pose-moi n'importe quoi sur un match\n\nExemples :\n• _"Qui va gagner ce soir ?"_\n• _"T'en penses quoi du match CL ?"_\n• _"Y'a du BTTS intéressant cette semaine ?"_`;
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

    // 2. Commande /joueur [nom] — recherche joueur en direct (RapidAPI)
    const joueurMatch = text.match(/^\/joueur(?:@\w+)?\s+(.+)/i);
    if (joueurMatch) {
      const nomRecherche = joueurMatch[1].trim();
      try {
        const joueurs = await searchPlayers(nomRecherche);
        await send(chatId, formatJoueurs(nomRecherche, joueurs));
      } catch (e) {
        console.error('Erreur searchPlayers:', e);
        await send(chatId, `J'ai eu un souci pour chercher *"${nomRecherche}"*, réessaie dans un instant 🙏`);
      }
      return new Response('OK');
    }
    if (/^\/joueur\b/i.test(text)) {
      await send(chatId, `Dis-moi qui chercher ! Exemple : \`/joueur Mbappé\``);
      return new Response('OK');
    }

    // 3. Charger les pronostics
    const { donnees, count, matchsResume } = await chargerPronostics();

    // 4. Commande /pronostics — Groq analyse tous les pronos et choisit le meilleur
    if (/^\/pronostics/.test(text.toLowerCase())) {
      if (!count) {
        await send(chatId,
          `Pas de matchs analysés pour cette semaine pour l'instant...\n\nLes données sont mises à jour chaque nuit — reviens demain matin, j'aurai du nouveau 🌙`
        );
        return new Response('OK');
      }

      // Récupérer tous les pronostics bruts pour l'analyse Groq
      const now2   = new Date().toISOString();
      const in7j2  = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const { data: tousLesPronos } = await supabase
        .from('pronostics_finaux')
        .select('home_team, away_team, competition, match_date, pronostic_type, pronostic_valeur, fiabilite, cote_conseille, analyse_texte')
        .gte('match_date', now2)
        .lte('match_date', in7j2)
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

      if (!choixMsg) {
        // Fallback : meilleur par fiabilité + cote
        const top = (tousLesPronos ?? [])
          .sort((a, b) => b.fiabilite - a.fiabilite || b.cote_conseille - a.cote_conseille)[0];
        if (top) {
          const fiabEmoji = top.fiabilite >= 75 ? '🟢' : top.fiabilite >= 60 ? '🟡' : '🔴';
          choixMsg = `🎯 *Mon choix de la semaine :*\n*${top.home_team} vs ${top.away_team}*\n→ *${top.pronostic_type}: ${top.pronostic_valeur}* — cote ${top.cote_conseille} ${fiabEmoji}\n${top.analyse_texte ? '_' + top.analyse_texte + '_\n' : ''}`;
        }
      }

      await send(chatId, `${choixMsg}\n──────────────────\n*Tous les pronos :*\n${matchsResume}`);
      return new Response('OK');
    }

    // 5. Pas de données mais question posée
    if (!count) {
      await send(chatId,
        `Honnêtement, j'ai pas de matchs analysés cette semaine pour l'instant.\n\nLes crons tournent chaque nuit — reviens demain et j'aurai mes analyses fraîches 🌙`
      );
      return new Response('OK');
    }

    // 6. Consommer quota Groq
    const groqOk = await consommerGroq();
    if (!groqOk) {
      // Fallback direct si quota épuisé
      await send(chatId, `J'ai beaucoup travaillé aujourd'hui, je recharge 😅\n\nVoilà direct mes pronos :\n${matchsResume}`);
      return new Response('OK');
    }

    // 7. Réponse Groq conversationnelle
    const reponse = await groqReponse(text, donnees, prenom);
    await send(chatId, reponse);

    return new Response('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('Error', { status: 500 });
  }
});
