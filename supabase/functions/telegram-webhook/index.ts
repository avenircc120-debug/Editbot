/**
 * telegram-webhook — Editbot
 *
 * 100% conversationnel : aucune commande à taper. L'utilisateur écrit
 * librement, l'assistant GROQ comprend l'intention et répond. Quatre actions
 * bien distinctes peuvent être proposées, chacune avec son propre bouton,
 * toutes ouvrant la même mini-app à onglets (app.html) sauf Facebook :
 *   - Compétitions (choisir les ligues suivies)   → app.html?tab=competitions (Web App)
 *   - Coupons (codes 1xbet / 1win)                → app.html?tab=coupons (Web App)
 *   - Wallet (dépôt / retrait / historique)       → app.html?tab=wallet (Web App)
 *   - Connexion Facebook                          → ouvre un lien externe (obligatoire :
 *     Meta bloque l'OAuth dans les navigateurs embarqués/WebView, donc ce bouton ne
 *     peut pas être une Web App Telegram — c'est une contrainte de Facebook, pas un choix).
 *
 * Multi-comptes Facebook : un utilisateur peut connecter autant de Pages Facebook
 * qu'il le souhaite (comptes différents ou pages différentes d'un même compte).
 * La déconnexion se fait page par page, jamais en masse.
 *
 * Double garde-fou (le modèle GROQ hallucine parfois des commandes /xxx
 * malgré le prompt) :
 *  1. Détection déterministe de l'intention à partir du message utilisateur
 *     (mots-clés), en plus des marqueurs [[BUTTON:...]] émis par le modèle.
 *  2. Nettoyage systématique (au niveau phrase) de toute mention de commande
 *     slash ou du mot "commande"/"taper" dans le texte final avant envoi.
 *
 * Données réelles (jamais inventées) :
 *  - Calendrier + scores : TheSportsDB (voir _shared/thesportsdb.ts), indexés
 *    en base par la fonction cron fetch-matches dans matchs_index.
 *  - Compositions d'équipe (lineups) : TheSportsDB lookuplineup, récupérées à
 *    la volée pour les matchs en direct ou dans les 3h, uniquement quand
 *    disponibles (souvent publiées ~1h avant le coup d'envoi).
 *  - Recherche de joueur par nom : RapidAPI free-api-live-football-data
 *    (_shared/apifootball.ts), utilisée à la volée quand le message
 *    mentionne un nom propre.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';
import { getLineupsMatch } from '../_shared/thesportsdb.ts';
import { searchPlayers } from '../_shared/apifootball.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const FACEBOOK_APP_ID = Deno.env.get('FACEBOOK_APP_ID')           ?? '';
const WEB_APP_URL     = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const REDIRECT_URI    = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

const RE_COMPETITION      = /(compétition|compétitions|ligue|ligues|championnat)/i;
const RE_COUPON           = /(coupon|coupons|1xbet|1win|code promo|bookmaker)/i;
const RE_WALLET            = /(wallet|portefeuille|solde|dépôt|depot|retrait|retirer|argent|gains?)/i;
const RE_FACEBOOK          = /facebook/i;
const RE_DECONNECTER_FB    = /(déconnecter|deconnecter|supprimer|retirer|enlever|désactiver|desactiver).{0,20}facebook/i;
const RE_MES_PAGES         = /(mes pages|mes comptes|mes connexions|voir.{0,15}facebook|combien.{0,15}facebook|facebook.{0,15}connect)/i;
const RE_AJOUTER_FB        = /(ajouter|connecter|lier|relier|nouveau.{0,10}compte|autre.{0,10}compte|nouvelle.{0,10}page|autre.{0,10}page).{0,20}facebook/i;
const RE_SLASH             = /`?\/[a-zA-Z_]+`?/g;

// Mots français courants à exclure quand on extrait un possible nom de joueur
// (majuscule en début de phrase, sinon on aurait trop de faux positifs).
const MOTS_COURANTS = new Set(['Le','La','Les','Un','Une','Des','Il','Elle','Je','Tu','Nous','Vous','Ils','Elles','Est','Ce','Cette','Aujourd','Salut','Bonjour','Merci','Ligue','Championnat','Coupe','Match']);

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
  });
}

/** Récupère (ou crée) le profil de l'utilisateur et indique s'il est nouveau. */
async function assurerProfil(chatId: number): Promise<{ token: string; nouveau: boolean }> {
  const { data: existant } = await supabase
    .from('user_profiles')
    .select('web_access_token')
    .eq('telegram_user_id', chatId)
    .maybeSingle();

  if (existant) return { token: existant.web_access_token ?? '', nouveau: false };

  const { data: cree } = await supabase
    .from('user_profiles')
    .insert({ telegram_user_id: chatId })
    .select('web_access_token')
    .single();

  return { token: cree?.web_access_token ?? '', nouveau: true };
}

/** Construit un contexte matchs riche : aujourd'hui, à venir (7 jours), résultats récents (48h),
 *  et compositions d'équipe (lineups) réelles pour les matchs en direct ou imminents (±3h). */
async function contexteMatchs(): Promise<string> {
  const maintenant = new Date();
  const debutHier = new Date(maintenant.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const finSemaine = new Date(maintenant.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('matchs_index')
    .select('competition, home_team, away_team, match_date, status, home_score, away_score, id_thesportsdb')
    .gte('match_date', debutHier)
    .lte('match_date', finSemaine)
    .order('match_date', { ascending: true })
    .limit(120);

  if (!data?.length) return "Aucun match trouvé dans les prochains jours ni dans les 48 dernières heures, pour les compétitions suivies.";

  const ligne = (m: typeof data[number]) => {
    const date = new Date(m.match_date);
    const jourHeure = date.toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const score = m.home_score !== null && m.away_score !== null ? ` — score ${m.home_score}-${m.away_score} (${m.status})` : ` — ${jourHeure} UTC (${m.status})`;
    return `- [${m.competition}] ${m.home_team} vs ${m.away_team}${score}`;
  };

  const termines = data.filter((m) => m.status === 'finished' || m.status === 'match finished' || (m.home_score !== null && new Date(m.match_date) < maintenant));
  const aVenir   = data.filter((m) => !termines.includes(m));

  const sections: string[] = [];
  if (termines.length) sections.push('Résultats récents (48 dernières heures) :\n' + termines.map(ligne).join('\n'));
  if (aVenir.length)   sections.push('Matchs à venir (7 prochains jours, y compris aujourd\'hui) :\n' + aVenir.map(ligne).join('\n'));

  // Compositions d'équipe réelles pour les matchs en direct ou dans les 3 prochaines heures
  // (TheSportsDB ne les publie en général qu'à l'approche du coup d'envoi — on ne récupère
  // donc que sur cette fenêtre pour ne pas gaspiller le quota sur des matchs lointains).
  const troisHeures = 3 * 60 * 60 * 1000;
  const imminents = data.filter((m) => {
    const delta = new Date(m.match_date).getTime() - maintenant.getTime();
    return m.id_thesportsdb && (Math.abs(delta) <= troisHeures || /live|1h|2h|ht|in progress/i.test(m.status));
  }).slice(0, 3); // on limite pour ne pas multiplier les appels API à chaque message

  const blocsCompos: string[] = [];
  for (const m of imminents) {
    const lineup = await getLineupsMatch(m.id_thesportsdb as string);
    if (!lineup?.length) continue;
    const parCamp = (home: boolean) => lineup
      .filter((j) => (j.strHome === 'Yes') === home && j.strSubstitute !== 'Yes')
      .map((j) => `${j.strPlayer} (${j.strPosition})`)
      .join(', ');
    const domicile = parCamp(true);
    const exterieur = parCamp(false);
    if (domicile || exterieur) {
      blocsCompos.push(`Composition ${m.home_team} vs ${m.away_team} :\n- ${m.home_team} : ${domicile || 'non publiée'}\n- ${m.away_team} : ${exterieur || 'non publiée'}`);
    }
  }
  if (blocsCompos.length) sections.push('Compositions officielles disponibles :\n' + blocsCompos.join('\n\n'));

  return sections.join('\n\n');
}

/** Si le message mentionne un nom propre qui ressemble à un joueur, cherche une correspondance
 *  réelle (RapidAPI). Retourne un texte de contexte explicite, y compris quand rien n'est trouvé,
 *  pour que le modèle ne devine jamais à la place d'une vraie donnée. */
async function contexteJoueurMentionne(texte: string): Promise<string | null> {
  const mots = texte.match(/\b[A-ZÀ-Ý][a-zà-ÿ'-]{2,}\b/g) ?? [];
  const candidats = mots.filter((m) => !MOTS_COURANTS.has(m));
  if (!candidats.length) return null;

  // On essaie d'abord deux mots consécutifs (prénom + nom), sinon un seul mot.
  const requete = candidats.slice(0, 2).join(' ');

  const suggestions = await searchPlayers(requete, supabase);
  if (!suggestions.length) {
    return `Recherche joueur pour "${requete}" : aucune correspondance trouvée dans la base réelle. Ne pas inventer d'informations sur ce joueur — dis clairement que tu n'as pas cette donnée.`;
  }

  const lignes = suggestions.slice(0, 5).map((s) => `- ${s.name}${s.teamName ? ` (${s.teamName})` : ''}`);
  return `Résultat recherche joueur pour "${requete}" (source réelle) :\n${lignes.join('\n')}`;
}

/** Génère un lien OAuth Facebook sécurisé (nonce anti-CSRF à usage unique, valable 10 min). */
async function genererLienFacebook(chatId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await supabase.from('facebook_oauth_states').insert({
    nonce,
    telegram_user_id: chatId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  // On retourne une URL Supabase (pas facebook.com) pour éviter que l'OS Android
  // n'intercepte le clic via App Links et n'ouvre l'app Facebook Lite directement.
  // La fonction facebook-oauth fera elle-même le redirect 302 vers Facebook —
  // les redirects HTTP côté navigateur ne déclenchent pas les App Links Android.
  return `${REDIRECT_URI}?init=1&nonce=${nonce}`;
}

/** Retire toute phrase mentionnant une commande slash hallucinée (nettoyage au niveau phrase,
 *  pour ne jamais laisser un fragment cassé comme "il suffit de taper . Cela te permettra...").  */
function nettoyer(texte: string): string {
  const segments = texte.split(/(?<=[.!?])\s+|\n+/);
  const gardees = segments.filter((seg) =>
    !RE_SLASH.test(seg) && !/\bcommandes?\b/i.test(seg) && !/\btaper\b/i.test(seg)
  );
  return gardees.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/** Envoie la liste des Pages Facebook connectées avec un bouton de déconnexion par page.
 *  Ajoute toujours un bouton pour connecter un compte/page supplémentaire. */
async function envoyerListePages(chatId: number): Promise<void> {
  const { data: connexions } = await supabase
    .from('facebook_connections')
    .select('id, fb_page_name, fb_page_id, last_post_at')
    .eq('telegram_user_id', chatId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (!connexions?.length) {
    await sendTelegram(chatId,
      '📭 *Aucune Page Facebook connectée.*\n\nDis-moi *"connecter Facebook"* pour relier ta première Page.');
    return;
  }

  const nPages = connexions.length;
  const liste = connexions.map((c, i) => {
    const dernierPost = c.last_post_at
      ? `dernier post : ${new Date(c.last_post_at).toLocaleDateString('fr-FR')}`
      : 'aucun post encore';
    return `${i + 1}. *${c.fb_page_name}* — ${dernierPost}`;
  }).join('\n');

  // Un bouton de déconnexion par page + un bouton pour ajouter une page
  const rangees: Array<Array<{ text: string; url?: string; callback_data?: string }>> = [];
  for (const c of connexions) {
    rangees.push([{
      text: `❌ Déconnecter "${c.fb_page_name}"`,
      callback_data: `deconnect_fb_page:${c.id}`,
    }]);
  }

  // Bouton pour ajouter une nouvelle page
  rangees.push([{ text: '➕ Connecter une autre Page Facebook', callback_data: 'ajouter_fb_page' }]);

  await sendTelegram(
    chatId,
    `📄 *Tes Pages Facebook connectées (${nPages}) :*\n\n${liste}\n\nLes pronostics sont publiés sur toutes ces pages automatiquement. Tu peux déconnecter une page individuelle ou en ajouter une nouvelle.`,
    { inline_keyboard: rangees },
  );
}

async function repondreConversation(chatId: number, texte: string, token: string, nouveau: boolean) {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const brut = session?.history;
  const historique: ChatMessage[] = Array.isArray(brut) ? (brut as ChatMessage[]) : [];

  historique.push({ role: 'user', content: texte });

  const [matchs, { data: connexions }, joueur] = await Promise.all([
    contexteMatchs(),
    // On récupère toutes les connexions actives (pas juste 1) pour le contexte et l'affichage
    supabase.from('facebook_connections').select('id, fb_page_name').eq('telegram_user_id', chatId).eq('is_active', true),
    contexteJoueurMentionne(texte),
  ]);
  const nPagesConnectees = connexions?.length ?? 0;
  const facebookConnecte = nPagesConnectees > 0;
  const resumePages = facebookConnecte
    ? `connectée (${nPagesConnectees} page${nPagesConnectees > 1 ? 's' : ''} : ${connexions!.map(c => c.fb_page_name).join(', ')})`
    : 'non connectée';

  const contexte = `${matchs}${joueur ? `\n\n${joueur}` : ''}

Statut utilisateur : ${nouveau ? "nouvel utilisateur, jamais accueilli jusqu'ici" : 'utilisateur déjà connu, ne pas ré-accueillir'}.
Connexion Facebook : ${resumePages}.
Note : l'utilisateur peut connecter plusieurs Pages Facebook différentes (comptes différents ou pages différentes d'un même compte). Ne jamais laisser entendre qu'une seule page est possible.`;

  let reponse = await chatAssistant(historique.slice(-10), contexte);

  // Détection déterministe de l'intention (garde-fou en plus des marqueurs du modèle)
  const veutVoirPages      = facebookConnecte && (RE_MES_PAGES.test(texte) || reponse.includes('[[BUTTON:FACEBOOK]]'));
  const veutAjouterFb      = RE_AJOUTER_FB.test(texte) || (!facebookConnecte && RE_FACEBOOK.test(texte) && !RE_DECONNECTER_FB.test(texte));
  const veutDeconnecterFb  = facebookConnecte && RE_DECONNECTER_FB.test(texte);
  const veutCompetitions   = reponse.includes('[[BUTTON:COMPETITIONS]]') || RE_COMPETITION.test(texte);
  const veutCoupons        = reponse.includes('[[BUTTON:COUPONS]]')      || RE_COUPON.test(texte);
  const veutWallet          = reponse.includes('[[BUTTON:WALLET]]')       || RE_WALLET.test(texte);

  reponse = reponse
    .replace('[[BUTTON:FACEBOOK]]', '')
    .replace('[[BUTTON:COMPETITIONS]]', '')
    .replace('[[BUTTON:COUPONS]]', '')
    .replace('[[BUTTON:WALLET]]', '');
  reponse = nettoyer(reponse);

  // Chaque bouton sur sa propre ligne, jamais mélangés dans un seul lien.
  const rangees: Array<Array<{ text: string; url?: string; web_app?: { url: string }; callback_data?: string }>> = [];
  if (veutCompetitions) rangees.push([{ text: '🏆 Mes compétitions', web_app: { url: `${WEB_APP_URL}/app.html?tab=competitions&token=${token}` } }]);
  if (veutCoupons)      rangees.push([{ text: '🎟️ Mes coupons', web_app: { url: `${WEB_APP_URL}/app.html?tab=coupons&token=${token}` } }]);
  if (veutWallet)       rangees.push([{ text: '💰 Mon wallet', web_app: { url: `${WEB_APP_URL}/app.html?tab=wallet&token=${token}` } }]);

  // Ajouter une (nouvelle) page Facebook — toujours un lien OAuth externe
  if (veutAjouterFb) {
    const lien = await genererLienFacebook(chatId);
    rangees.push([{ text: facebookConnecte ? '➕ Ajouter une Page Facebook' : '🔗 Connecter Facebook', url: lien }]);
  }

  // Voir / gérer les pages connectées
  if (veutVoirPages || veutDeconnecterFb) {
    rangees.push([{ text: '📄 Voir mes Pages Facebook', callback_data: 'list_fb_pages' }]);
  }

  const boutons = rangees.length ? { inline_keyboard: rangees } : undefined;

  historique.push({ role: 'assistant', content: reponse });

  await supabase.from('bot_sessions').upsert({
    chat_id: chatId,
    history: historique.slice(-20),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });

  await sendTelegram(chatId, reponse, boutons);
}

Deno.serve(async (req: Request) => {
  const update = await req.json().catch(() => null);
  if (!update) return new Response('ok');

  // ── Callback query (clic sur un bouton inline) ──────────────────────────
  const cb = update.callback_query;
  if (cb) {
    const cbChatId = cb.message?.chat?.id as number;
    const cbData: string = cb.data ?? '';

    // Acquitte toujours le callback pour supprimer le spinner Telegram
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callback_query_id: cb.id }),
    });

    // ── Afficher la liste des pages connectées ──────────────────────────
    if (cbData === 'list_fb_pages') {
      await envoyerListePages(cbChatId);
      return new Response('ok');
    }

    // ── Ajouter une nouvelle page Facebook (générer un lien OAuth) ──────
    if (cbData === 'ajouter_fb_page') {
      const lien = await genererLienFacebook(cbChatId);
      await sendTelegram(
        cbChatId,
        '🔗 Clique sur le bouton ci-dessous pour connecter une nouvelle Page Facebook.\n\n_Le lien est valable 10 minutes._',
        { inline_keyboard: [[{ text: '➕ Connecter une Page Facebook', url: lien }]] },
      );
      return new Response('ok');
    }

    // ── Déconnecter UNE page spécifique ─────────────────────────────────
    if (cbData.startsWith('deconnect_fb_page:')) {
      const pageId = parseInt(cbData.split(':')[1], 10);
      if (!isNaN(pageId)) {
        // Récupère le nom de la page avant de la désactiver
        const { data: page } = await supabase
          .from('facebook_connections')
          .select('fb_page_name')
          .eq('id', pageId)
          .eq('telegram_user_id', cbChatId)   // sécurité : l'utilisateur ne peut déconnecter que ses propres pages
          .maybeSingle();

        await supabase
          .from('facebook_connections')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', pageId)
          .eq('telegram_user_id', cbChatId);

        const nomPage = page?.fb_page_name ?? 'cette Page';
        await sendTelegram(
          cbChatId,
          `✅ *"${nomPage}"* a été déconnectée. Les pronostics ne seront plus publiés sur cette page.\n\nTes autres Pages restent actives. Dis-moi *"mes pages Facebook"* pour voir la liste mise à jour.`,
        );
      }
      return new Response('ok');
    }

    // ── Compatibilité ascendante : déconnexion globale (ancien bouton) ──
    if (cbData === 'deconnect_facebook') {
      // Redirige vers la liste plutôt que de tout couper d'un coup
      await envoyerListePages(cbChatId);
      await sendTelegram(
        cbChatId,
        '⚠️ Choisis la Page à déconnecter dans la liste ci-dessus. Les pronostics continueront sur les autres Pages.',
      );
      return new Response('ok');
    }
  }

  // ── Message texte ordinaire ─────────────────────────────────────────────
  const message = update.message;
  if (!message?.chat?.id) return new Response('ok');

  const chatId = message.chat.id as number;
  const texte: string = (message.text ?? '').trim();
  if (!texte) return new Response('ok');

  const { token, nouveau } = await assurerProfil(chatId);
  await repondreConversation(chatId, texte, token, nouveau);

  return new Response('ok');
});
