/**
 * telegram-webhook — Editbot (Live Scores)
 *
 * Bot de diffusion des scores en direct.
 *
 * Principe :
 *   - Chaque utilisateur choisit UNE compétition (modifiable à tout moment).
 *   - Le bot affiche les matchs du jour, les scores en direct, le programme 7j.
 *   - Les scores sont automatiquement publiés sur les Pages Facebook connectées.
 *   - Pas de pronostics ni statistiques.
 *
 * Multi-comptes Facebook : un utilisateur peut connecter plusieurs Pages.
 * La déconnexion se fait page par page.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';
import { LEAGUES } from '../_shared/config.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const WEB_APP_URL     = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const REDIRECT_URI    = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Détection d'intention ─────────────────────────────────────────────────────
const RE_EN_DIRECT      = /(en direct|live|score.{0,10}(direct|maintenant)|ce qui se passe|qu.est.ce qui se joue|qu.est.ce qui joue)/i;
const RE_AUJOURD_HUI    = /(aujourd.?hui|ce soir|ce matin|matchs? du jour|qu.est.ce qu.il y a aujourd|y a.t.il)/i;
const RE_PROGRAMME      = /(programme|calendrier|planning|cette semaine|prochains? matchs?|à venir|quand.{0,10}joue)/i;
const RE_CHANGER_COMPET = /(chang|modif|choisir|sélectionn|selectionn|autre compétition|autre ligue|compétition|competition|championnat|ligue)\b/i;
const RE_COUPON         = /(coupon|coupons|1xbet|1win|code promo)/i;
const RE_WALLET         = /(wallet|portefeuille|solde|dépôt|depot|retrait|retirer|argent|gains?)/i;
const RE_FACEBOOK       = /facebook/i;
const RE_DECONNECTER_FB = /(déconnecter|deconnecter|supprimer|retirer|enlever|désactiver).{0,20}facebook/i;
const RE_MES_PAGES      = /(mes pages|mes comptes|mes connexions|voir.{0,15}facebook|combien.{0,15}facebook)/i;
const RE_AJOUTER_FB     = /(ajouter|connecter|lier|relier|nouveau.{0,10}compte|autre.{0,10}compte|nouvelle.{0,10}page|autre.{0,10}page).{0,20}facebook/i;

// ─── Types ─────────────────────────────────────────────────────────────────────
interface ProfilUtilisateur {
  token: string;
  nouveau: boolean;
  competitionSuivie: string | null;
  competitionSuivieId: string | null;
}

// ─── Utilitaires ───────────────────────────────────────────────────────────────

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
    if (!res.ok) {
      console.error('[telegram] sendMessage HTTP', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[telegram] sendMessage erreur réseau:', err);
  }
}

async function assurerProfil(chatId: number): Promise<ProfilUtilisateur> {
  const { data: existant } = await supabase
    .from('user_profiles')
    .select('web_access_token, competition_suivie, competition_suivie_id')
    .eq('telegram_user_id', chatId)
    .maybeSingle();

  if (existant) {
    return {
      token:               existant.web_access_token ?? '',
      nouveau:             false,
      competitionSuivie:   existant.competition_suivie ?? null,
      competitionSuivieId: existant.competition_suivie_id ?? null,
    };
  }

  const { data: cree } = await supabase
    .from('user_profiles')
    .insert({ telegram_user_id: chatId })
    .select('web_access_token')
    .single();

  return { token: cree?.web_access_token ?? '', nouveau: true, competitionSuivie: null, competitionSuivieId: null };
}

async function sauvegarderCompetition(chatId: number, tsdbId: string, nom: string): Promise<void> {
  await supabase
    .from('user_profiles')
    .update({
      competition_suivie:    nom,
      competition_suivie_id: tsdbId,
      updated_at:            new Date().toISOString(),
    })
    .eq('telegram_user_id', chatId);
}

async function genererLienFacebook(chatId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await supabase.from('facebook_oauth_states').insert({
    nonce,
    telegram_user_id: chatId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  return `${REDIRECT_URI}?init=1&nonce=${nonce}`;
}

// ─── Menu compétitions ──────────────────────────────────────────────────────────

function buildMenuCompetitions(): Array<Array<{ text: string; callback_data: string }>> {
  const rangees: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < LEAGUES.length; i += 2) {
    const rangee = [];
    const l1 = LEAGUES[i];
    rangee.push({ text: `${l1.flag} ${l1.name}`, callback_data: `sel_comp:${l1.tsdb_id}` });
    if (LEAGUES[i + 1]) {
      const l2 = LEAGUES[i + 1];
      rangee.push({ text: `${l2.flag} ${l2.name}`, callback_data: `sel_comp:${l2.tsdb_id}` });
    }
    rangees.push(rangee);
  }
  return rangees;
}

async function envoyerMenuCompetitions(chatId: number, competitionActuelle?: string | null): Promise<void> {
  const entete = competitionActuelle
    ? `🏆 Tu suis actuellement *${competitionActuelle}*.\n\nChoisis une autre compétition :`
    : `🏆 *Choisis ta compétition à suivre :*\n\nTu peux la changer à tout moment.`;

  await sendTelegram(chatId, entete, { inline_keyboard: buildMenuCompetitions() });
}

// ─── Affichage des matchs ───────────────────────────────────────────────────────

function formatHeure(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function formatDateCourte(isoDate: string): string {
  return new Date(isoDate).toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function ligneMatch(m: { home_team: string; away_team: string; match_date: string; status: string; home_score: number | null; away_score: number | null }): string {
  if (m.status === 'inprogress') {
    return `🔴 *${m.home_team} ${m.home_score ?? '?'}-${m.away_score ?? '?'} ${m.away_team}* _(en direct)_`;
  }
  if (m.status === 'finished') {
    return `✅ *${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}* _(terminé)_`;
  }
  if (m.status === 'postponed') {
    return `⚠️ ${m.home_team} vs ${m.away_team} _(reporté)_`;
  }
  return `⚽ *${m.home_team} vs ${m.away_team}* — ${formatHeure(m.match_date)} UTC`;
}

const BOUTONS_NAVIGATION = {
  inline_keyboard: [
    [
      { text: '🔴 En direct',       callback_data: 'voir_direct'    },
      { text: '📅 Aujourd\'hui',    callback_data: 'matchs_jour'    },
    ],
    [
      { text: '📆 Programme 7j',    callback_data: 'voir_programme' },
      { text: '🔄 Changer compét.', callback_data: 'menu_compet'   },
    ],
  ],
};

async function envoyerMatchsEnDirect(chatId: number, competition: string, competitionId: string): Promise<void> {
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('home_team, away_team, match_date, status, home_score, away_score')
    .eq('tournament_id', competitionId)
    .eq('status', 'inprogress')
    .order('match_date', { ascending: true });

  if (!matchs?.length) {
    // Pas de match en direct → affiche les prochains du jour
    const auj = new Date().toISOString().slice(0, 10);
    const { data: aVenir } = await supabase
      .from('matchs_index')
      .select('home_team, away_team, match_date')
      .eq('tournament_id', competitionId)
      .gte('match_date', `${auj}T00:00:00Z`)
      .lte('match_date', `${auj}T23:59:59Z`)
      .eq('status', 'scheduled')
      .order('match_date', { ascending: true })
      .limit(5);

    if (aVenir?.length) {
      const lignes = aVenir.map(m => `⚽ *${m.home_team} vs ${m.away_team}* — ${formatHeure(m.match_date)} UTC`);
      await sendTelegram(
        chatId,
        `⏸ Aucun match *${competition}* en direct maintenant.\n\n📅 *À venir aujourd'hui :*\n${lignes.join('\n')}`,
        BOUTONS_NAVIGATION,
      );
    } else {
      await sendTelegram(
        chatId,
        `⏸ Aucun match *${competition}* en direct pour l'instant.`,
        BOUTONS_NAVIGATION,
      );
    }
    return;
  }

  const lignes = matchs.map(ligneMatch);
  await sendTelegram(
    chatId,
    `🔴 *${competition}* — En direct\n\n${lignes.join('\n')}`,
    { inline_keyboard: [[{ text: '🔄 Actualiser', callback_data: 'voir_direct' }], [{ text: '📆 Programme 7j', callback_data: 'voir_programme' }]] },
  );
}

async function envoyerMatchsDuJour(chatId: number, competition: string, competitionId: string): Promise<void> {
  const auj = new Date().toISOString().slice(0, 10);
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('home_team, away_team, match_date, status, home_score, away_score')
    .eq('tournament_id', competitionId)
    .gte('match_date', `${auj}T00:00:00Z`)
    .lte('match_date', `${auj}T23:59:59Z`)
    .order('match_date', { ascending: true });

  if (!matchs?.length) {
    await sendTelegram(
      chatId,
      `📭 Pas de match *${competition}* aujourd'hui.`,
      { inline_keyboard: [[{ text: '📆 Programme 7j', callback_data: 'voir_programme' }], [{ text: '🔄 Changer compét.', callback_data: 'menu_compet' }]] },
    );
    return;
  }

  const lignes = matchs.map(ligneMatch);
  await sendTelegram(
    chatId,
    `📅 *${competition}* — Aujourd'hui\n\n${lignes.join('\n')}`,
    BOUTONS_NAVIGATION,
  );
}

async function envoyerProgramme(chatId: number, competition: string, competitionId: string): Promise<void> {
  const maintenant = new Date();
  const finSemaine = new Date(maintenant.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('home_team, away_team, match_date, status, home_score, away_score')
    .eq('tournament_id', competitionId)
    .gte('match_date', maintenant.toISOString())
    .lte('match_date', finSemaine)
    .neq('status', 'postponed')
    .order('match_date', { ascending: true })
    .limit(20);

  if (!matchs?.length) {
    await sendTelegram(
      chatId,
      `📭 Aucun match *${competition}* dans les 7 prochains jours.`,
      { inline_keyboard: [[{ text: '🔄 Changer compét.', callback_data: 'menu_compet' }]] },
    );
    return;
  }

  const lignes = matchs.map(m => {
    if (m.status === 'inprogress') return ligneMatch(m);
    return `📅 *${m.home_team} vs ${m.away_team}* — ${formatDateCourte(m.match_date)} UTC`;
  });

  // Découpage en messages de 10 matchs max (limite 4096 chars Telegram)
  const chunks: string[][] = [];
  for (let i = 0; i < lignes.length; i += 10) chunks.push(lignes.slice(i, i + 10));

  await sendTelegram(chatId, `📆 *${competition}* — Programme 7 jours\n\n${chunks[0].join('\n')}`);
  for (let i = 1; i < chunks.length; i++) {
    await sendTelegram(chatId, chunks[i].join('\n'));
  }
  await sendTelegram(chatId, '_Mis à jour en temps réel._', BOUTONS_NAVIGATION);
}

// ─── Liste des Pages Facebook ───────────────────────────────────────────────────

async function envoyerListePages(chatId: number): Promise<void> {
  const { data: connexions } = await supabase
    .from('facebook_connections')
    .select('id, fb_page_name, fb_page_id, last_post_at')
    .eq('telegram_user_id', chatId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (!connexions?.length) {
    await sendTelegram(chatId, '📭 *Aucune Page Facebook connectée.*\n\nDis-moi *"connecter Facebook"* pour relier ta première Page.');
    return;
  }

  const liste = connexions.map((c, i) => {
    const dernierPost = c.last_post_at
      ? `dernier post : ${new Date(c.last_post_at).toLocaleDateString('fr-FR')}`
      : 'aucun post encore';
    return `${i + 1}. *${c.fb_page_name}* — ${dernierPost}`;
  }).join('\n');

  const rangees: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  for (const c of connexions) {
    rangees.push([{ text: `❌ Déconnecter "${c.fb_page_name}"`, callback_data: `deconnect_fb_page:${c.id}` }]);
  }
  rangees.push([{ text: '➕ Ajouter une Page Facebook', callback_data: 'ajouter_fb_page' }]);

  await sendTelegram(
    chatId,
    `📄 *Tes Pages Facebook (${connexions.length}) :*\n\n${liste}\n\nLes scores sont publiés automatiquement sur toutes ces pages.`,
    { inline_keyboard: rangees },
  );
}

// ─── Conversation GROQ (pour les questions ouvertes) ───────────────────────────

async function repondreConversation(chatId: number, texte: string, token: string, profil: ProfilUtilisateur): Promise<void> {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const historique: ChatMessage[] = Array.isArray(session?.history) ? (session!.history as ChatMessage[]) : [];

  historique.push({ role: 'user', content: texte });

  // Contexte matchs pour le modèle (simplifié, pas de pronostics)
  const competId = profil.competitionSuivieId;
  let contexteMatchs = profil.competitionSuivie
    ? `Compétition suivie par l'utilisateur : ${profil.competitionSuivie}`
    : 'Aucune compétition sélectionnée.';

  if (competId) {
    const maintenant = new Date();
    const hier  = new Date(maintenant.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const j7    = new Date(maintenant.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: matchs } = await supabase
      .from('matchs_index')
      .select('home_team, away_team, match_date, status, home_score, away_score')
      .eq('tournament_id', competId)
      .gte('match_date', hier)
      .lte('match_date', j7)
      .order('match_date', { ascending: true })
      .limit(30);

    if (matchs?.length) {
      const lignes = matchs.map(m => {
        if (m.status === 'inprogress') return `[EN DIRECT] ${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}`;
        if (m.status === 'finished')   return `[Terminé] ${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}`;
        return `[Prévu] ${m.home_team} vs ${m.away_team} — ${new Date(m.match_date).toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC`;
      });
      contexteMatchs += '\n\nMatchs (48h passées + 7j à venir) :\n' + lignes.join('\n');
    }
  }

  // Infos Facebook
  const { data: connexions } = await supabase
    .from('facebook_connections')
    .select('fb_page_name')
    .eq('telegram_user_id', chatId)
    .eq('is_active', true);
  const nPages = connexions?.length ?? 0;
  const fbStatut = nPages > 0
    ? `Connectée (${nPages} page${nPages > 1 ? 's' : ''} : ${connexions!.map(c => c.fb_page_name).join(', ')})`
    : 'Non connectée';

  const contexte = `${contexteMatchs}

Connexion Facebook : ${fbStatut}
Statut : ${profil.nouveau ? 'nouvel utilisateur' : 'utilisateur existant'}`;

  let reponse = await chatAssistant(historique.slice(-10), contexte);

  // Suppression des marqueurs et construction des boutons
  const veutCompetitions = reponse.includes('[[BUTTON:COMPETITIONS]]') || (RE_CHANGER_COMPET.test(texte) && !profil.competitionSuivie);
  const veutCoupons      = reponse.includes('[[BUTTON:COUPONS]]')      || RE_COUPON.test(texte);
  const veutWallet       = reponse.includes('[[BUTTON:WALLET]]')        || RE_WALLET.test(texte);
  const veutAjouterFb    = reponse.includes('[[BUTTON:FACEBOOK]]')      || (RE_AJOUTER_FB.test(texte) && !profil.competitionSuivie);

  reponse = reponse
    .replace(/\[\[BUTTON:[A-Z_]+\]\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const rangees: Array<Array<unknown>> = [];
  if (veutCompetitions) rangees.push([{ text: '🏆 Choisir ma compétition', callback_data: 'menu_compet' }]);
  if (veutCoupons)      rangees.push([{ text: '🎟️ Mes coupons', web_app: { url: `${WEB_APP_URL}/app.html?tab=coupons&token=${profil.token}` } }]);
  if (veutWallet)       rangees.push([{ text: '💰 Mon wallet', web_app: { url: `${WEB_APP_URL}/app.html?tab=wallet&token=${profil.token}` } }]);
  if (veutAjouterFb) {
    const lien = await genererLienFacebook(chatId);
    rangees.push([{ text: nPages > 0 ? '➕ Ajouter une Page Facebook' : '🔗 Connecter Facebook', url: lien }]);
  }

  historique.push({ role: 'assistant', content: reponse });
  await supabase.from('bot_sessions').upsert({
    chat_id: chatId, history: historique.slice(-20), updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });

  await sendTelegram(chatId, reponse, rangees.length ? { inline_keyboard: rangees } : undefined);
}

// ─── Handler principal ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
  const update = await req.json().catch(() => null);
  if (!update) return new Response('ok');

  // ── Callbacks (clic sur bouton inline) ──────────────────────────────────────
  const cb = update.callback_query;
  if (cb) {
    const chatId: number = cb.message?.chat?.id;
    const data: string   = cb.data ?? '';

    // Acquittement immédiat (supprime le spinner Telegram)
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id }),
    });

    const { competitionSuivie, competitionSuivieId } = await assurerProfil(chatId);

    // ── Sélection de compétition ────────────────────────────────────────────
    if (data.startsWith('sel_comp:')) {
      const tsdbId = data.split(':')[1];
      const ligue  = LEAGUES.find(l => l.tsdb_id === tsdbId);
      if (ligue) {
        await sauvegarderCompetition(chatId, ligue.tsdb_id, ligue.name);
        await sendTelegram(
          chatId,
          `✅ *${ligue.flag} ${ligue.name}* sélectionnée !\n\nTu recevras les scores en direct et je publierai automatiquement sur ta Page Facebook.`,
          BOUTONS_NAVIGATION,
        );
      }
      return new Response('ok');
    }

    // ── Afficher menu compétitions ──────────────────────────────────────────
    if (data === 'menu_compet') {
      await envoyerMenuCompetitions(chatId, competitionSuivie);
      return new Response('ok');
    }

    // ── Matchs en direct ────────────────────────────────────────────────────
    if (data === 'voir_direct') {
      if (!competitionSuivie || !competitionSuivieId) {
        await envoyerMenuCompetitions(chatId);
      } else {
        await envoyerMatchsEnDirect(chatId, competitionSuivie, competitionSuivieId);
      }
      return new Response('ok');
    }

    // ── Matchs du jour ──────────────────────────────────────────────────────
    if (data === 'matchs_jour') {
      if (!competitionSuivie || !competitionSuivieId) {
        await envoyerMenuCompetitions(chatId);
      } else {
        await envoyerMatchsDuJour(chatId, competitionSuivie, competitionSuivieId);
      }
      return new Response('ok');
    }

    // ── Programme 7 jours ───────────────────────────────────────────────────
    if (data === 'voir_programme') {
      if (!competitionSuivie || !competitionSuivieId) {
        await envoyerMenuCompetitions(chatId);
      } else {
        await envoyerProgramme(chatId, competitionSuivie, competitionSuivieId);
      }
      return new Response('ok');
    }

    // ── Liste des Pages Facebook ────────────────────────────────────────────
    if (data === 'list_fb_pages') {
      await envoyerListePages(chatId);
      return new Response('ok');
    }

    // ── Ajouter une nouvelle Page Facebook ──────────────────────────────────
    if (data === 'ajouter_fb_page') {
      const lien = await genererLienFacebook(chatId);
      await sendTelegram(chatId,
        '🔗 Clique ci-dessous pour connecter une nouvelle Page Facebook.\n_Lien valable 10 minutes._',
        { inline_keyboard: [[{ text: '➕ Connecter une Page Facebook', url: lien }]] },
      );
      return new Response('ok');
    }

    // ── Déconnecter une Page Facebook ───────────────────────────────────────
    if (data.startsWith('deconnect_fb_page:')) {
      const pageId = parseInt(data.split(':')[1], 10);
      if (!isNaN(pageId)) {
        const { data: page } = await supabase
          .from('facebook_connections')
          .select('fb_page_name')
          .eq('id', pageId)
          .eq('telegram_user_id', chatId)
          .maybeSingle();

        await supabase
          .from('facebook_connections')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', pageId)
          .eq('telegram_user_id', chatId);

        await sendTelegram(chatId,
          `✅ *"${page?.fb_page_name ?? 'Page'}"* déconnectée. Les scores ne seront plus publiés sur cette page.`,
        );
      }
      return new Response('ok');
    }

    // Compatibilité ascendante : ancienne déconnexion globale
    if (data === 'deconnect_facebook') {
      await envoyerListePages(chatId);
      return new Response('ok');
    }

    return new Response('ok');
  }

  // ── Message texte ────────────────────────────────────────────────────────────
  const message = update.message;
  if (!message?.chat?.id) return new Response('ok');

  const chatId: number = message.chat.id;
  const texte: string  = (message.text ?? '').trim();
  if (!texte) return new Response('ok');

  const profil = await assurerProfil(chatId);
  const { competitionSuivie, competitionSuivieId } = profil;

  // ── Pas de compétition → forcer le choix ────────────────────────────────────
  if (!competitionSuivie) {
    if (profil.nouveau) {
      await sendTelegram(chatId,
        `👋 *Bienvenue sur Editbot !*\n\nJe diffuse les scores en direct sur ta Page Facebook.\n\nCommence par choisir la compétition que tu veux suivre :`,
        { inline_keyboard: buildMenuCompetitions() },
      );
    } else {
      await envoyerMenuCompetitions(chatId);
    }
    return new Response('ok');
  }

  // ── Handlers directs (sans GROQ) ─────────────────────────────────────────────

  if (RE_EN_DIRECT.test(texte)) {
    await envoyerMatchsEnDirect(chatId, competitionSuivie, competitionSuivieId!);
    return new Response('ok');
  }

  if (RE_AUJOURD_HUI.test(texte)) {
    await envoyerMatchsDuJour(chatId, competitionSuivie, competitionSuivieId!);
    return new Response('ok');
  }

  if (RE_PROGRAMME.test(texte)) {
    await envoyerProgramme(chatId, competitionSuivie, competitionSuivieId!);
    return new Response('ok');
  }

  if (RE_CHANGER_COMPET.test(texte)) {
    await envoyerMenuCompetitions(chatId, competitionSuivie);
    return new Response('ok');
  }

  if (RE_MES_PAGES.test(texte) || RE_DECONNECTER_FB.test(texte)) {
    await envoyerListePages(chatId);
    return new Response('ok');
  }

  // ── Conversation ouverte → GROQ ──────────────────────────────────────────────
  await repondreConversation(chatId, texte, profil.token, profil);
  return new Response('ok');

  } catch (err) {
    // Filet de sécurité global : on log l'erreur mais on retourne toujours 200
    // pour éviter que Telegram ne réessaie en boucle et multiplie les erreurs.
    console.error('[webhook] ERREUR NON CAPTURÉE:', err);
    return new Response('ok');
  }
});
