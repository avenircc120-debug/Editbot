/**
 * telegram-webhook — Editbot (Live Scores)
 *
 * Le bot affiche les scores dans le chat.
 * Tout le reste (compétition, Facebook, wallet, coupons) → Mini App.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatAssistant, type ChatMessage } from '../_shared/groq.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const WEB_APP_URL    = (Deno.env.get('WEB_APP_URL') ?? '').replace(/\/$/, '');
const REDIRECT_URI   = `${SUPABASE_URL}/functions/v1/facebook-oauth`;
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Détection d'intention ─────────────────────────────────────────────────────
const RE_EN_DIRECT   = /(en direct|live|score.{0,10}(direct|maintenant)|ce qui se passe|qu.est.ce qui se joue)/i;
const RE_AUJOURD_HUI = /(aujourd.?hui|ce soir|ce matin|matchs? du jour|y a.t.il)/i;
const RE_PROGRAMME   = /(programme|calendrier|planning|cette semaine|prochains? matchs?|à venir|quand.{0,10}joue)/i;
const RE_WALLET       = /(solde|wallet|portefeuille|dépôt|depot|retrait|argent|combien.{0,15}ai|mon compte)/i;
const RE_COUPONS      = /(coupon|code.{0,10}promo|bookmaker|1xbet|1win|code.{0,10}réduc|réduction)/i;
const RE_FACEBOOK_TAB = /(mes? pages? facebook|page.{0,15}(connecter|relier|gérer|voir)|diffus|broadcast)/i;
const RE_COMPETITIONS = /(compétition|competition|championnat|ligue|chang.{0,15}comp|choisir.{0,15}comp|sélectionn|selectionn)/i;
const RE_AJOUTER_FB  = /(ajouter|connecter|lier|relier).{0,20}facebook/i;

// ─── Types ─────────────────────────────────────────────────────────────────────
interface ProfilUtilisateur {
  token: string;
  nouveau: boolean;
  competitionSuivie: string | null;
  competitionSuivieId: string | null;
}

// ─── Boutons ───────────────────────────────────────────────────────────────────

function miniAppBtn(label = '🟢 Mon espace') {
  return WEB_APP_URL ? { text: label, web_app: { url: WEB_APP_URL } } : null;
}

function miniAppTabBtn(tab: 'matchs' | 'facebook' | 'wallet' | 'coupons', label: string) {
  return WEB_APP_URL ? { text: label, web_app: { url: `${WEB_APP_URL}?tab=${tab}` } } : null;
}

const BOUTONS_SCORES = () => {
  const btn = miniAppBtn();
  return {
    inline_keyboard: [
      [
        { text: '🔴 En direct',    callback_data: 'voir_direct'    },
        { text: '📅 Aujourd\'hui', callback_data: 'matchs_jour'    },
      ],
      [
        { text: '📆 Programme 7j', callback_data: 'voir_programme' },
        ...(btn ? [btn] : []),
      ],
    ],
  };
};

// ─── Utilitaires ───────────────────────────────────────────────────────────────

async function sendTelegram(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
    if (!res.ok) console.error('[telegram] sendMessage HTTP', res.status, await res.text().catch(() => ''));
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
      competitionSuivie:   existant.competition_suivie   ?? null,
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

// ─── Envoyer vers la Mini App ──────────────────────────────────────────────────

async function renvoyerMiniApp(chatId: number, msg: string): Promise<void> {
  const btn = miniAppBtn();
  await sendTelegram(
    chatId,
    msg,
    btn ? { inline_keyboard: [[btn]] } : undefined,
  );
}

// ─── Génération lien Facebook OAuth ───────────────────────────────────────────

async function genererLienFacebook(chatId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await supabase.from('facebook_oauth_states').insert({
    nonce,
    telegram_user_id: chatId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  return `${REDIRECT_URI}?init=1&nonce=${nonce}`;
}

// ─── Affichage des scores ───────────────────────────────────────────────────────

function formatHeure(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function formatDateCourte(isoDate: string): string {
  return new Date(isoDate).toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function ligneMatch(m: { home_team: string; away_team: string; match_date: string; status: string; home_score: number | null; away_score: number | null }): string {
  if (m.status === 'inprogress') return `🔴 *${m.home_team} ${m.home_score ?? '?'}-${m.away_score ?? '?'} ${m.away_team}* _(en direct)_`;
  if (m.status === 'finished')   return `✅ *${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}* _(terminé)_`;
  if (m.status === 'postponed')  return `⚠️ ${m.home_team} vs ${m.away_team} _(reporté)_`;
  return `⚽ *${m.home_team} vs ${m.away_team}* — ${formatHeure(m.match_date)} UTC`;
}

async function envoyerMatchsEnDirect(chatId: number, competition: string, competitionId: string): Promise<void> {
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('home_team, away_team, match_date, status, home_score, away_score')
    .eq('tournament_id', competitionId)
    .eq('status', 'inprogress')
    .order('match_date', { ascending: true });

  if (!matchs?.length) {
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
      return sendTelegram(chatId,
        `⏸ Aucun match *${competition}* en direct.\n\n📅 *À venir aujourd'hui :*\n${lignes.join('\n')}`,
        BOUTONS_SCORES(),
      );
    }
    return sendTelegram(chatId, `⏸ Aucun match *${competition}* en direct pour l'instant.`, BOUTONS_SCORES());
  }

  await sendTelegram(chatId,
    `🔴 *${competition}* — En direct\n\n${matchs.map(ligneMatch).join('\n')}`,
    { inline_keyboard: [
      [{ text: '🔄 Actualiser', callback_data: 'voir_direct' }],
      [{ text: '📆 Programme 7j', callback_data: 'voir_programme' }, ...(miniAppBtn() ? [miniAppBtn()!] : [])],
    ]},
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
    return sendTelegram(chatId, `📭 Pas de match *${competition}* aujourd'hui.`, BOUTONS_SCORES());
  }
  await sendTelegram(chatId, `📅 *${competition}* — Aujourd'hui\n\n${matchs.map(ligneMatch).join('\n')}`, BOUTONS_SCORES());
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
    return sendTelegram(chatId, `📭 Aucun match *${competition}* dans les 7 prochains jours.`, BOUTONS_SCORES());
  }

  const lignes = matchs.map(m =>
    m.status === 'inprogress' ? ligneMatch(m) : `📅 *${m.home_team} vs ${m.away_team}* — ${formatDateCourte(m.match_date)} UTC`
  );

  const chunks: string[][] = [];
  for (let i = 0; i < lignes.length; i += 10) chunks.push(lignes.slice(i, i + 10));

  await sendTelegram(chatId, `📆 *${competition}* — Programme 7 jours\n\n${chunks[0].join('\n')}`);
  for (let i = 1; i < chunks.length; i++) await sendTelegram(chatId, chunks[i].join('\n'));
  await sendTelegram(chatId, '_Mis à jour en temps réel._', BOUTONS_SCORES());
}

// ─── Conversation GROQ ─────────────────────────────────────────────────────────

async function repondreConversation(chatId: number, texte: string, profil: ProfilUtilisateur): Promise<void> {
  const { data: session } = await supabase.from('bot_sessions').select('history').eq('chat_id', chatId).maybeSingle();
  const historique: ChatMessage[] = Array.isArray(session?.history) ? (session!.history as ChatMessage[]) : [];

  historique.push({ role: 'user', content: texte });

  // Contexte matchs
  let contexteMatchs = profil.competitionSuivie
    ? `Compétition suivie : ${profil.competitionSuivie}`
    : 'Aucune compétition sélectionnée.';

  if (profil.competitionSuivieId) {
    const maintenant = new Date();
    const hier = new Date(maintenant.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const j7   = new Date(maintenant.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: matchs } = await supabase
      .from('matchs_index')
      .select('home_team, away_team, match_date, status, home_score, away_score')
      .eq('tournament_id', profil.competitionSuivieId)
      .gte('match_date', hier).lte('match_date', j7)
      .order('match_date', { ascending: true }).limit(30);

    if (matchs?.length) {
      const lignes = matchs.map(m => {
        if (m.status === 'inprogress') return `[EN DIRECT] ${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}`;
        if (m.status === 'finished')   return `[Terminé] ${m.home_team} ${m.home_score}-${m.away_score} ${m.away_team}`;
        return `[Prévu] ${m.home_team} vs ${m.away_team} — ${new Date(m.match_date).toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC`;
      });
      contexteMatchs += '\n\nMatchs :\n' + lignes.join('\n');
    }
  }

  const contexte = `${contexteMatchs}\n\nStatut : ${profil.nouveau ? 'nouvel utilisateur' : 'utilisateur existant'}\nMini App disponible : ${WEB_APP_URL ? 'oui' : 'non'}`;

  let reponse = await chatAssistant(historique.slice(-10), contexte);

    // Convertir les marqueurs [[BUTTON:...]] en boutons vers les onglets de Mon espace
    const ONGLET_MAP: Record<string, { label: string; tab: 'matchs' | 'facebook' | 'wallet' | 'coupons' }> = {
      'COMPETITIONS': { label: '🏆 Choisir ma compétition', tab: 'matchs'   },
      'WALLET':       { label: '💰 Mon solde',               tab: 'wallet'   },
      'COUPONS':      { label: '🎟 Mes coupons',             tab: 'coupons'  },
      'FACEBOOK':     { label: '📘 Ma page Facebook',        tab: 'facebook' },
    };
    const boutonsTrouves = [...reponse.matchAll(/\[\[BUTTON:([A-Z_]+)\]\]/g)]
      .map(m => ONGLET_MAP[m[1]])
      .filter(Boolean) as { label: string; tab: 'matchs' | 'facebook' | 'wallet' | 'coupons' }[];

    reponse = reponse.replace(/\[\[BUTTON:[A-Z_]+\]\]/g, '').replace(/\s{2,}/g, ' ').trim();

    historique.push({ role: 'assistant', content: reponse });
    await supabase.from('bot_sessions').upsert(
      { chat_id: chatId, history: historique.slice(-20), updated_at: new Date().toISOString() },
      { onConflict: 'chat_id' },
    );

    let keyboard: unknown;
    if (boutonsTrouves.length > 0) {
      const rows = boutonsTrouves.map(o => miniAppTabBtn(o.tab, o.label)).filter(Boolean);
      keyboard = rows.length ? { inline_keyboard: rows.map(b => [b!]) } : undefined;
    } else {
      const btn = miniAppBtn();
      keyboard = btn ? { inline_keyboard: [[btn]] } : undefined;
    }

    await sendTelegram(chatId, reponse, keyboard);
    }

// ─── Handler principal ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
    const update = await req.json().catch(() => null);
    if (!update) return new Response('ok');

    // ── Callbacks ────────────────────────────────────────────────────────────
    const cb = update.callback_query;
    if (cb) {
      const chatId: number = cb.message?.chat?.id;
      const data: string   = cb.data ?? '';

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id }),
      });

      const { competitionSuivie, competitionSuivieId } = await assurerProfil(chatId);

      if (data === 'voir_direct') {
        if (!competitionSuivie || !competitionSuivieId) {
          await renvoyerMiniApp(chatId, '⚽ Choisis d\'abord ta compétition dans la Mini App :');
        } else {
          await envoyerMatchsEnDirect(chatId, competitionSuivie, competitionSuivieId);
        }
        return new Response('ok');
      }

      if (data === 'matchs_jour') {
        if (!competitionSuivie || !competitionSuivieId) {
          await renvoyerMiniApp(chatId, '⚽ Choisis d\'abord ta compétition dans la Mini App :');
        } else {
          await envoyerMatchsDuJour(chatId, competitionSuivie, competitionSuivieId);
        }
        return new Response('ok');
      }

      if (data === 'voir_programme') {
        if (!competitionSuivie || !competitionSuivieId) {
          await renvoyerMiniApp(chatId, '⚽ Choisis d\'abord ta compétition dans la Mini App :');
        } else {
          await envoyerProgramme(chatId, competitionSuivie, competitionSuivieId);
        }
        return new Response('ok');
      }

      // Anciens callbacks de compétition — redirige vers la Mini App
      if (data === 'menu_compet' || data.startsWith('sel_comp:')) {
        await renvoyerMiniApp(chatId, '⚽ Choisis ta compétition directement dans la Mini App :');
        return new Response('ok');
      }

      // Anciens callbacks Facebook — redirige vers la Mini App
      if (data === 'list_fb_pages' || data === 'ajouter_fb_page' || data.startsWith('deconnect_fb_page:')) {
        await renvoyerMiniApp(chatId, '📄 Gère tes Pages Facebook depuis la Mini App :');
        return new Response('ok');
      }

      return new Response('ok');
    }

    // ── Message texte ─────────────────────────────────────────────────────────
    const message = update.message;
    if (!message?.chat?.id) return new Response('ok');

    const chatId: number = message.chat.id;
    const texte: string  = (message.text ?? '').trim();
    if (!texte) return new Response('ok');

    const profil = await assurerProfil(chatId);
    const { competitionSuivie, competitionSuivieId } = profil;

    // ── Nouvel utilisateur ────────────────────────────────────────────────────
    if (profil.nouveau) {
      await renvoyerMiniApp(chatId,
        `👋 *Bienvenue sur Editbot !*\n\nJe diffuse les scores en direct sur ta Page Facebook.\n\nCommence par ouvrir la Mini App pour choisir ta compétition et connecter ta Page Facebook :`,
      );
      return new Response('ok');
    }

    // ── Pas de compétition → Mini App ─────────────────────────────────────────
    if (!competitionSuivie) {
      await renvoyerMiniApp(chatId, '⚽ Ouvre la Mini App pour choisir ta compétition :');
      return new Response('ok');
    }

    // ── Scores en direct (pas de GROQ) ───────────────────────────────────────
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

    // ── Connecter Facebook (lien direct OAuth) ────────────────────────────────
    if (RE_AJOUTER_FB.test(texte)) {
      const lien = await genererLienFacebook(chatId);
      await sendTelegram(chatId,
        '🔗 Clique ci-dessous pour connecter une nouvelle Page Facebook.\n_Lien valable 10 minutes._',
        { inline_keyboard: [[{ text: '➕ Connecter une Page Facebook', url: lien }]] },
      );
      return new Response('ok');
    }

    // ── Routing par onglet ────────────────────────────────────────────────────
    if (RE_WALLET.test(texte)) {
      const btn = miniAppTabBtn('wallet', '💰 Voir mon solde');
      await sendTelegram(chatId, '💰 Ton solde et tes opérations sont dans l\'onglet *Solde* de Mon espace 👇', btn ? { inline_keyboard: [[btn]] } : undefined);
      return new Response('ok');
    }

    if (RE_COUPONS.test(texte)) {
      const btn = miniAppTabBtn('coupons', '🎟 Mes coupons');
      await sendTelegram(chatId, '🎟 Tes codes coupons se gèrent dans l\'onglet *Coupons* de Mon espace 👇', btn ? { inline_keyboard: [[btn]] } : undefined);
      return new Response('ok');
    }

    if (RE_FACEBOOK_TAB.test(texte) && !RE_AJOUTER_FB.test(texte)) {
      const btn = miniAppTabBtn('facebook', '📘 Mes pages Facebook');
      await sendTelegram(chatId, '📘 Tes pages Facebook se gèrent dans Mon espace 👇', btn ? { inline_keyboard: [[btn]] } : undefined);
      return new Response('ok');
    }

    if (RE_COMPETITIONS.test(texte)) {
      const btn = miniAppTabBtn('matchs', '🏆 Choisir ma compétition');
      await sendTelegram(chatId, '🏆 Change ta compétition directement dans Mon espace 👇', btn ? { inline_keyboard: [[btn]] } : undefined);
      return new Response('ok');
    }

    // ── Conversation libre → GROQ ─────────────────────────────────────────────
    await repondreConversation(chatId, texte, profil);
    return new Response('ok');

  } catch (err) {
    console.error('[webhook] ERREUR NON CAPTURÉE:', err);
    return new Response('ok');
  }
});
