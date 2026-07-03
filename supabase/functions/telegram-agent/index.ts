// ═══════════════════════════════════════════════════════
//  FOOTBOT v6 — Assistant Football Universel
//  Groq détecte l'intention → ESPN fournit les données
//  Pronostics | Classements | Scores | Équipes | Joueurs | Actu
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG       = `https://api.telegram.org/bot${TG_TOKEN}`;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_V2   = "https://site.api.espn.com/apis/v2/sports/soccer";
const ESPN_HDR  = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── ESPN leagues slug mapping ─────────────────────────
const LEAGUES: Record<string, string> = {
  "premier league": "eng.1",  "pl": "eng.1",         "angleterre": "eng.1",  "epl": "eng.1",
  "la liga": "esp.1",         "liga": "esp.1",        "espagne": "esp.1",
  "ligue 1": "fra.1",         "ligue1": "fra.1",      "france": "fra.1",
  "bundesliga": "ger.1",      "allemagne": "ger.1",
  "serie a": "ita.1",         "italie": "ita.1",
  "champions league": "uefa.champions", "ldc": "uefa.champions", "ucl": "uefa.champions", "ligue des champions": "uefa.champions",
  "europa league": "uefa.europa", "el": "uefa.europa", "ligue europa": "uefa.europa",
  "conference league": "uefa.europa.conf", "uecl": "uefa.europa.conf",
  "mls": "usa.1",             "usa": "usa.1",
  "eredivisie": "ned.1",      "pays-bas": "ned.1",
  "liga portugal": "por.1",   "portugal": "por.1",
  "world cup": "fifa.world",  "coupe du monde": "fifa.world", "cdm": "fifa.world",
  "afcon": "caf.nations",     "can": "caf.nations",   "coupe d'afrique": "caf.nations",
  "nations league": "uefa.nations", "ligue des nations": "uefa.nations",
};

function detectLeague(text: string): string {
  const lower = text.toLowerCase();
  for (const [key, slug] of Object.entries(LEAGUES)) {
    if (lower.includes(key)) return slug;
  }
  return "fra.1"; // défaut Ligue 1
}

// ── ESPN Fetch avec timeout + retry ──────────────────
async function espnFetch(url: string, attempt = 0): Promise<any> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const r     = await fetch(url, { headers: ESPN_HDR, signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 2) { await sleep(1200 * (attempt + 1)); return espnFetch(url, attempt + 1); }
    return null;
  } catch {
    if (attempt < 2) { await sleep(1000); return espnFetch(url, attempt + 1); }
    return null;
  }
}

const todayESPN = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

const fmtTime = (dateStr: string) =>
  new Date(dateStr).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

// ══════════════════════════════════════════════════════
//  SESSION Supabase
// ══════════════════════════════════════════════════════
type Phase = "idle" | "awaiting_count";

function sbH(): Record<string, string> {
  return {
    "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
  };
}

async function loadPhase(chatId: number): Promise<Phase> {
  if (!SB_URL || !SB_KEY) return "idle";
  try {
    const r = await fetch(`${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase`, { headers: sbH() });
    if (!r.ok) return "idle";
    const rows: any[] = await r.json();
    return (rows?.[0]?.phase as Phase) ?? "idle";
  } catch { return "idle"; }
}

async function savePhase(chatId: number, phase: Phase): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method: "POST", headers: sbH(),
      body: JSON.stringify({ chat_id: chatId, phase }),
    });
  } catch { /* non bloquant */ }
}

// ══════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════
async function send(chatId: number, text: string): Promise<void> {
  // Telegram limite à 4096 chars par message
  if (text.length > 4000) {
    await send(chatId, text.slice(0, 4000));
    await sleep(300);
    await send(chatId, text.slice(4000));
    return;
  }
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(console.error);
}

async function typing(chatId: number): Promise<void> {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

async function keepTyping(chatId: number, durationMs: number): Promise<void> {
  let elapsed = 0;
  while (elapsed < durationMs) {
    await typing(chatId);
    await sleep(4000);
    elapsed += 4000;
  }
}

// ══════════════════════════════════════════════════════
//  GROQ — Détection d'intention universelle
// ══════════════════════════════════════════════════════

interface Intent {
  intent : "pronostics" | "classement" | "scores_live" | "programme" | "equipe" | "joueur" | "actualites" | "h2h" | "general" | "salutation" | "nombre";
  league ?: string;   // slug ESPN ex: "eng.1"
  team   ?: string;   // nom d'équipe
  team2  ?: string;   // pour H2H
  player ?: string;   // nom du joueur
  count  ?: number;   // pour pronostics
}

async function detectIntent(message: string): Promise<Intent> {
  if (!GROQ_KEY) return { intent: "general" };

  const prompt = `Tu es un classifieur de messages pour un bot Telegram football.
Analyse ce message et retourne UNIQUEMENT un objet JSON valide (aucun texte avant ou après).

Message: "${message}"

Intents possibles:
- "salutation" : bonjour, salut, hello, hi, slt, bjr, cc, hey, bonsoir, wesh, salam, yo, etc.
- "nombre" : chiffre seul ou réponse à "combien de matchs"
- "pronostics" : demande de pronostics, prédictions, conseils paris, analyse de matchs
- "classement" : classement d'une ligue, tableau, standings
- "scores_live" : scores en direct, résultats live, ce qui se passe maintenant
- "programme" : matchs du jour, ce soir, demain, programme, calendrier
- "equipe" : infos sur une équipe (forme, résultats, effectif)
- "joueur" : infos sur un joueur (stats, buts, situation)
- "actualites" : news foot, transferts, actualités, mercato
- "h2h" : historique face-à-face entre deux équipes
- "general" : toute autre question football (règles, histoire, records, etc.)

Champs à remplir selon l'intent:
- league: slug ESPN ("eng.1"=Premier League, "esp.1"=LaLiga, "fra.1"=Ligue1, "ger.1"=Bundesliga, "ita.1"=SerieA, "uefa.champions"=UCL, "uefa.europa"=EL, "caf.nations"=CAN, "fifa.world"=CM)
- team: nom de l'équipe mentionnée
- team2: deuxième équipe (pour h2h)
- player: nom du joueur mentionné
- count: nombre de matchs (pour pronostics)

Réponds UNIQUEMENT avec le JSON, exemple:
{"intent":"classement","league":"eng.1"}
{"intent":"joueur","player":"Mbappé"}
{"intent":"equipe","team":"PSG","league":"fra.1"}
{"intent":"pronostics","count":5}
{"intent":"salutation"}`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 120,
      }),
    });
    if (!r.ok) return { intent: "general" };
    const data: any = await r.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    return JSON.parse(jsonStr) as Intent;
  } catch {
    return { intent: "general" };
  }
}

// ══════════════════════════════════════════════════════
//  GROQ — Réponse général football (QA)
// ══════════════════════════════════════════════════════
async function groqGeneralQA(chatId: number, question: string, context?: string): Promise<void> {
  if (!GROQ_KEY) {
    await send(chatId, "❓ Je n'ai pas pu trouver une réponse. Essaie une question plus précise !");
    return;
  }
  const typingLoop = keepTyping(chatId, 20000);
  try {
    const systemPrompt = `Tu es FootBot, un assistant football expert et passionné. 
Tu réponds en français, de façon concise (max 300 mots), avec des emojis pertinents.
Tu couvres tout : résultats, joueurs, équipes, règles, histoire, transferts, tactiques, records.
Si tu mentionnes des stats ou faits, précise l'année/saison.
${context ? `\nDonnées ESPN disponibles:\n${context}` : ""}`;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
    });
    if (r.ok) {
      const data: any = await r.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (answer) { await send(chatId, answer); return; }
    }
  } catch { /* fallback */ }
  await send(chatId, "⚽ Bonne question ! Mais je n'arrive pas à charger ma réponse là. Réessaie dans un instant.");
}

// ══════════════════════════════════════════════════════
//  HANDLER — CLASSEMENT
// ══════════════════════════════════════════════════════
async function handleClassement(chatId: number, leagueSlug: string, originalText: string): Promise<void> {
  const slug = leagueSlug || detectLeague(originalText);
  const typingLoop = keepTyping(chatId, 15000);

  try {
    const data = await espnFetch(`${ESPN_V2}/${slug}/standings`);
    if (!data) {
      await groqGeneralQA(chatId, originalText);
      return;
    }

    const groups = data.children ?? data.standings?.entries ? [data] : (data.children ?? []);
    let lines: string[] = [];
    const leagueName = data.name ?? data.abbreviation ?? slug;
    lines.push(`🏆 <b>Classement ${leagueName}</b>\n`);

    const addEntries = (entries: any[]) => {
      entries.slice(0, 20).forEach((entry: any, i: number) => {
        const team = entry.team?.displayName ?? entry.team?.shortDisplayName ?? "?";
        const stats = entry.stats ?? [];
        const pts  = stats.find((s: any) => s.name === "points")?.value ?? stats.find((s: any) => s.abbreviation === "PTS")?.value ?? "?";
        const pld  = stats.find((s: any) => s.name === "gamesPlayed")?.value ?? stats.find((s: any) => s.abbreviation === "GP")?.value ?? "?";
        const w    = stats.find((s: any) => s.name === "wins")?.value ?? stats.find((s: any) => s.abbreviation === "W")?.value ?? "";
        const d    = stats.find((s: any) => s.name === "ties")?.value ?? stats.find((s: any) => s.abbreviation === "D")?.value ?? "";
        const l    = stats.find((s: any) => s.name === "losses")?.value ?? stats.find((s: any) => s.abbreviation === "L")?.value ?? "";
        const gd   = stats.find((s: any) => s.name === "goalDifference")?.value ?? "";
        const pos  = i + 1;
        const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : `${pos}.`;
        const gdStr = gd !== "" ? ` (${gd > 0 ? "+" : ""}${gd})` : "";
        lines.push(`${medal} <b>${team}</b> — ${pts}pts | ${pld}J ${w}V${d}N${l}D${gdStr}`);
      });
    };

    if (groups.length > 0 && groups[0].standings?.entries) {
      for (const group of groups) {
        if (group.name) lines.push(`\n<b>${group.name}</b>`);
        addEntries(group.standings.entries ?? []);
      }
    } else if (data.standings?.entries) {
      addEntries(data.standings.entries);
    } else {
      await groqGeneralQA(chatId, originalText);
      return;
    }

    await send(chatId, lines.join("\n"));
  } catch {
    await groqGeneralQA(chatId, originalText);
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — SCORES LIVE
// ══════════════════════════════════════════════════════
async function handleScoresLive(chatId: number): Promise<void> {
  const typingLoop = keepTyping(chatId, 10000);
  try {
    // Cherche dans les principales ligues
    const slugs = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions"];
    const results: string[] = [];

    await Promise.all(slugs.map(async (slug) => {
      const data = await espnFetch(`${ESPN_BASE}/${slug}/scoreboard?dates=${todayESPN()}`);
      const events: any[] = data?.events ?? [];
      for (const ev of events) {
        const comp  = ev.competitions?.[0];
        const state = comp?.status?.type?.state;
        if (state !== "in") continue;
        const home  = comp?.competitors?.find((c: any) => c.homeAway === "home");
        const away  = comp?.competitors?.find((c: any) => c.homeAway === "away");
        const clock = comp?.status?.displayClock ?? comp?.status?.period ?? "";
        results.push(`⚡ <b>${home?.team?.displayName ?? "?"} ${home?.score ?? 0} - ${away?.score ?? 0} ${away?.team?.displayName ?? "?"}</b> (${clock})`);
      }
    }));

    if (!results.length) {
      await send(chatId, "📺 Aucun match en direct en ce moment sur les principales ligues.\n\nTape <b>programme</b> pour voir les matchs du jour !");
      return;
    }
    await send(chatId, `🔴 <b>SCORES EN DIRECT</b>\n\n${results.join("\n")}`);
  } catch {
    await send(chatId, "❌ Impossible de charger les scores live. Réessaie dans un instant !");
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — PROGRAMME DU JOUR
// ══════════════════════════════════════════════════════
async function handleProgramme(chatId: number): Promise<void> {
  const typingLoop = keepTyping(chatId, 15000);
  try {
    const slugs = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions", "uefa.europa"];
    const byLeague: Record<string, string[]> = {};

    await Promise.all(slugs.map(async (slug) => {
      const data = await espnFetch(`${ESPN_BASE}/${slug}/scoreboard?dates=${todayESPN()}`);
      const events: any[] = (data?.events ?? []).filter((e: any) =>
        e.competitions?.[0]?.status?.type?.state === "pre"
      );
      if (!events.length) return;
      const leagueName = data?.leagues?.[0]?.name ?? slug;
      byLeague[leagueName] = events.map(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
        const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
        const time = comp?.startDate ? fmtTime(comp.startDate) : "?";
        return `  ⏰ ${time} — ${home?.team?.displayName ?? "?"} vs ${away?.team?.displayName ?? "?"}`;
      });
    }));

    if (!Object.keys(byLeague).length) {
      await send(chatId, "📅 Aucun match prévu aujourd'hui dans les principales ligues européennes.");
      return;
    }

    const lines = ["📅 <b>PROGRAMME DU JOUR</b>\n"];
    for (const [league, matches] of Object.entries(byLeague)) {
      lines.push(`🏆 <b>${league}</b>`);
      lines.push(...matches);
      lines.push("");
    }
    await send(chatId, lines.join("\n"));
  } catch {
    await send(chatId, "❌ Impossible de charger le programme. Réessaie !");
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — ÉQUIPE
// ══════════════════════════════════════════════════════
async function handleEquipe(chatId: number, teamName: string, originalText: string): Promise<void> {
  if (!teamName) { await groqGeneralQA(chatId, originalText); return; }
  const typingLoop = keepTyping(chatId, 15000);

  try {
    // Cherche l'équipe dans plusieurs ligues
    const slugs = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions"];
    let found: any = null;
    let foundSlug = "";

    for (const slug of slugs) {
      const data = await espnFetch(`${ESPN_BASE}/${slug}/teams`);
      const teams: any[] = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
      const match = teams.find((t: any) => {
        const name = (t.team?.displayName ?? t.team?.name ?? "").toLowerCase();
        return name.includes(teamName.toLowerCase()) || teamName.toLowerCase().includes(name.split(" ")[0].toLowerCase());
      });
      if (match) { found = match.team; foundSlug = slug; break; }
      await sleep(150);
    }

    if (!found) {
      // Groq répond sur l'équipe depuis ses connaissances
      await groqGeneralQA(chatId, originalText);
      return;
    }

    // Récupère les derniers matchs de l'équipe
    const teamData = await espnFetch(`${ESPN_BASE}/${foundSlug}/teams/${found.id}`);
    const record = teamData?.team?.record?.items?.[0];
    const stats  = record?.stats ?? [];
    const wins   = stats.find((s: any) => s.name === "wins")?.value ?? "?";
    const losses = stats.find((s: any) => s.name === "losses")?.value ?? "?";
    const ties   = stats.find((s: any) => s.name === "ties")?.value ?? "?";

    const lines = [
      `⚽ <b>${found.displayName}</b>`,
      `🏆 ${found.league ?? foundSlug}`,
      `📊 Saison : <b>${wins}V - ${ties}N - ${losses}D</b>`,
    ];

    if (found.color) lines.push(`🎨 Couleurs : #${found.color}`);
    if (found.venue?.fullName) lines.push(`🏟️ Stade : ${found.venue.fullName}`);
    if (found.location) lines.push(`📍 ${found.location}`);

    await send(chatId, lines.join("\n"));

    // Complète avec Groq
    await groqGeneralQA(chatId, `Donne des infos actuelles sur l'équipe ${teamName} : forme récente, joueurs clés, entraîneur, et ce qu'il faut savoir.`, "");
  } catch {
    await groqGeneralQA(chatId, originalText);
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — JOUEUR
// ══════════════════════════════════════════════════════
async function handleJoueur(chatId: number, playerName: string, originalText: string): Promise<void> {
  if (!playerName) { await groqGeneralQA(chatId, originalText); return; }
  const typingLoop = keepTyping(chatId, 15000);

  try {
    // ESPN athlete search
    const encoded = encodeURIComponent(playerName);
    const data = await espnFetch(`https://site.web.api.espn.com/apis/common/v3/sports/soccer/athletes?limit=5&search=${encoded}`);
    const athletes: any[] = data?.athletes ?? [];

    if (!athletes.length) {
      // Fallback Groq
      await groqGeneralQA(chatId, originalText);
      return;
    }

    const p = athletes[0];
    const lines: string[] = [
      `👤 <b>${p.displayName ?? p.fullName ?? playerName}</b>`,
    ];
    if (p.position?.displayName) lines.push(`🎯 Poste : ${p.position.displayName}`);
    if (p.team?.displayName)     lines.push(`⚽ Club : ${p.team.displayName}`);
    if (p.age)                   lines.push(`🎂 Âge : ${p.age} ans`);
    if (p.nationality)           lines.push(`🌍 Nationalité : ${p.nationality}`);
    if (p.height)                lines.push(`📏 Taille : ${p.height}`);
    if (p.weight)                lines.push(`⚖️ Poids : ${p.weight}`);

    await send(chatId, lines.join("\n"));

    // Compléter avec stats Groq
    await groqGeneralQA(chatId, `Parle-moi de ${playerName} : ses stats cette saison, sa forme actuelle, son profil et ce qu'il faut savoir sur lui.`, "");
  } catch {
    await groqGeneralQA(chatId, originalText);
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — ACTUALITÉS
// ══════════════════════════════════════════════════════
async function handleActualites(chatId: number): Promise<void> {
  const typingLoop = keepTyping(chatId, 10000);
  try {
    const data = await espnFetch(`${ESPN_BASE}/news?limit=8`);
    const articles: any[] = data?.articles ?? [];

    if (!articles.length) {
      await groqGeneralQA(chatId, "Quelles sont les dernières actualités du football mondial ? Mercato, résultats importants, ce qui fait l'actualité.");
      return;
    }

    const lines = ["📰 <b>ACTU FOOT DU MOMENT</b>\n"];
    articles.slice(0, 6).forEach((a, i) => {
      const title    = a.headline ?? a.title ?? "?";
      const desc     = a.description ?? a.summary ?? "";
      const category = a.categories?.[0]?.description ?? "";
      lines.push(`${i + 1}. <b>${title}</b>`);
      if (desc) lines.push(`   ${desc.slice(0, 100)}${desc.length > 100 ? "..." : ""}`);
      if (category) lines.push(`   🏷️ ${category}`);
      lines.push("");
    });

    await send(chatId, lines.join("\n"));
  } catch {
    await groqGeneralQA(chatId, "Quelles sont les dernières actualités du football ? Transferts, résultats, mercato.");
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER — FACE À FACE (H2H)
// ══════════════════════════════════════════════════════
async function handleH2H(chatId: number, team1: string, team2: string, originalText: string): Promise<void> {
  const typingLoop = keepTyping(chatId, 8000);
  // ESPN H2H via search d'événements — on passe par Groq pour l'historique général
  await groqGeneralQA(chatId,
    `Quel est l'historique face-à-face entre ${team1} et ${team2} ? Donne les derniers résultats, qui domine, et les faits marquants de cette rivalité.`,
    ""
  );
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRONOSTICS (conservé de v5)
// ══════════════════════════════════════════════════════

interface TeamStats {
  form5       : string;
  wins5       : number;
  draws5      : number;
  losses5     : number;
  scored5     : number;
  conceded5   : number;
  avgScored   : number;
  avgConceded : number;
  over25Count : number;
  bttsCount   : number;
  cleanSheets : number;
  failedScore : number;
}

interface H2HStats {
  totalMatches : number;
  homeWinPct   : number;
  awayWinPct   : number;
  drawPct      : number;
  over25H2H    : number;
  bttsH2H      : number;
}

interface MatchData {
  id       : string;
  homeTeam : string;
  awayTeam : string;
  homeId   : string;
  awayId   : string;
  league   : string;
  kickoff  : string;
  homeStats: TeamStats;
  awayStats: TeamStats;
  h2h      : H2HStats;
  overUnder: number;
  homeML   : number;
  awayML   : number;
}

function extractFormESPN(events: any[], teamId: string): TeamStats {
  let wins5 = 0, draws5 = 0, losses5 = 0, scored5 = 0, conceded5 = 0;
  let over25Count = 0, bttsCount = 0, cleanSheets = 0, failedScore = 0;
  const formArr: string[] = [];

  for (const ev of events.slice(0, 5)) {
    const comp = ev.competitions?.[0] ?? ev;
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home" || c.team?.id === teamId);
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away" && c.team?.id !== teamId);
    const me   = comp?.competitors?.find((c: any) => c.team?.id === teamId) ?? home;
    const opp  = comp?.competitors?.find((c: any) => c.team?.id !== teamId) ?? away;
    if (!me || !opp) continue;

    const myScore  = parseInt(me.score ?? "0", 10) || 0;
    const oppScore = parseInt(opp.score ?? "0", 10) || 0;
    scored5   += myScore;
    conceded5 += oppScore;
    const total = myScore + oppScore;
    if (total > 2.5)  { over25Count++; }
    if (myScore > 0 && oppScore > 0) bttsCount++;
    if (oppScore === 0) cleanSheets++;
    if (myScore === 0)  failedScore++;

    if (me.winner === true || myScore > oppScore)  { wins5++;  formArr.push("V"); }
    else if (myScore === oppScore)                  { draws5++; formArr.push("N"); }
    else                                            { losses5++;formArr.push("D"); }
  }

  const played = wins5 + draws5 + losses5 || 1;
  return {
    form5: formArr.join("-") || "-",
    wins5, draws5, losses5, scored5, conceded5,
    avgScored   : Math.round((scored5 / played) * 10) / 10,
    avgConceded : Math.round((conceded5 / played) * 10) / 10,
    over25Count, bttsCount, cleanSheets, failedScore,
  };
}

function extractH2HESPN(h2hGames: any[], homeId: string): H2HStats {
  let total = 0, homeWins = 0, awayWins = 0, draws = 0, over25 = 0, btts = 0;

  for (const ev of h2hGames.slice(0, 10)) {
    const comp = ev.competitions?.[0] ?? ev;
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;
    total++;
    const hs = parseInt(home.score ?? "0", 10) || 0;
    const as_ = parseInt(away.score ?? "0", 10) || 0;
    if (hs > as_) { (home.team?.id === homeId ? homeWins++ : awayWins++); }
    else if (as_ > hs) { (away.team?.id === homeId ? homeWins++ : awayWins++); }
    else draws++;
    if (hs + as_ > 2.5) over25++;
    if (hs > 0 && as_ > 0) btts++;
  }

  return {
    totalMatches : total,
    homeWinPct   : total ? Math.round((homeWins / total) * 100) : 50,
    awayWinPct   : total ? Math.round((awayWins / total) * 100) : 50,
    drawPct      : total ? Math.round((draws / total) * 100) : 25,
    over25H2H    : over25,
    bttsH2H      : btts,
  };
}

async function scrapeMatchESPN(event: any): Promise<MatchData | null> {
  try {
    const comp    = event.competitions?.[0];
    const homeC   = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const awayC   = comp?.competitors?.find((c: any) => c.homeAway === "away");
    if (!homeC || !awayC) return null;

    const homeTeam = homeC.team?.displayName ?? "?";
    const awayTeam = awayC.team?.displayName ?? "?";
    const homeId   = homeC.team?.id ?? "";
    const awayId   = awayC.team?.id ?? "";
    const league   = event.league?.name ?? event.competitions?.[0]?.notes?.[0]?.headline ?? "Football";
    const kickoff  = comp?.startDate ? fmtTime(comp.startDate) : "?";

    const summary = await espnFetch(`${ESPN_BASE}/all/summary?event=${event.id}`);
    if (!summary) return null;

    await sleep(300);

    const lastFive: any[] = summary.lastFiveGames ?? [];
    const h2hData : any[] = summary.headToHeadGames ?? [];
    const oddsArr : any[] = summary.pickcenter ?? summary.odds ?? [];

    const homeFormData = lastFive.find((t: any) => t.team?.id === homeId);
    const awayFormData = lastFive.find((t: any) => t.team?.id === awayId);

    const homeStats = extractFormESPN(homeFormData?.events ?? [], homeId);
    const awayStats = extractFormESPN(awayFormData?.events ?? [], awayId);

    if (homeStats.wins5 + homeStats.draws5 + homeStats.losses5 < 1 &&
        awayStats.wins5 + awayStats.draws5 + awayStats.losses5 < 1) {
      return null;
    }

    const h2h = extractH2HESPN(h2hData, homeId);

    const odds    = oddsArr[0];
    const overUnder = odds?.overUnder ?? 2.5;
    const homeML    = odds?.homeTeamOdds?.moneyLine ?? 0;
    const awayML    = odds?.awayTeamOdds?.moneyLine ?? 0;

    return { id: event.id, homeTeam, awayTeam, homeId, awayId, league, kickoff, homeStats, awayStats, h2h, overUnder, homeML, awayML };
  } catch (e) {
    console.error("[SCRAPE ERROR]", e);
    return null;
  }
}

async function scrapeUpcomingMatches(count: number, onProgress: (msg: string) => Promise<void>): Promise<MatchData[]> {
  const data = await espnFetch(`${ESPN_BASE}/all/scoreboard?dates=${todayESPN()}`);
  const candidates: any[] = (data?.events ?? [])
    .filter((e: any) => e.competitions?.[0]?.status?.type?.state === "pre");

  if (!candidates.length) return [];

  const results: MatchData[] = [];
  for (const event of candidates) {
    if (results.length >= count) break;
    await onProgress(`🔍 ${results.length + 1}/${count} — <b>${event.name ?? "..."}</b>`);
    const match = await scrapeMatchESPN(event);
    if (match) results.push(match);
  }
  return results;
}

function computeSignals(m: MatchData): Record<string, number> {
  const h = m.homeStats;
  const a = m.awayStats;
  const x = m.h2h;

  const homeDom = (h.wins5 * 3 + h.draws5) / Math.max((h.wins5 + h.draws5 + h.losses5) * 3, 1);
  const awayDom = (a.wins5 * 3 + a.draws5) / Math.max((a.wins5 + a.draws5 + a.losses5) * 3, 1);

  let homeProb = 33, awayProb = 33;
  if (m.homeML > 0) homeProb = Math.round(100 / (m.homeML / 100 + 1));
  else if (m.homeML < 0) homeProb = Math.round(Math.abs(m.homeML) / (Math.abs(m.homeML) + 100) * 100);
  if (m.awayML > 0) awayProb = Math.round(100 / (m.awayML / 100 + 1));
  else if (m.awayML < 0) awayProb = Math.round(Math.abs(m.awayML) / (Math.abs(m.awayML) + 100) * 100);

  const homeWin = Math.round(homeDom * 50 + (x.homeWinPct / 100) * 25 + (homeProb / 100) * 25);
  const awayWin = Math.round(awayDom * 50 + (x.awayWinPct / 100) * 25 + (awayProb / 100) * 25);
  const draw    = Math.round(x.drawPct * 0.6 + 15);

  const over25total = (h.over25Count + a.over25Count) / Math.max((h.wins5 + h.draws5 + h.losses5 + a.wins5 + a.draws5 + a.losses5), 1);
  const overOULine  = m.overUnder <= 2.0 ? 10 : m.overUnder >= 3.0 ? -10 : 0;
  const over25 = Math.round(over25total * 80 + (x.over25H2H / Math.max(x.totalMatches, 1)) * 20 + overOULine);

  const homeSR = 1 - h.failedScore / Math.max(h.wins5 + h.draws5 + h.losses5, 1);
  const awaySR = 1 - a.failedScore / Math.max(a.wins5 + a.draws5 + a.losses5, 1);
  const homeCR = 1 - h.cleanSheets / Math.max(h.wins5 + h.draws5 + h.losses5, 1);
  const awayCR = 1 - a.cleanSheets / Math.max(a.wins5 + a.draws5 + a.losses5, 1);
  const btts   = Math.round(((homeSR * awayCR + awaySR * homeCR) / 2) * 70 + (x.bttsH2H / Math.max(x.totalMatches, 1)) * 30);

  return {
    homeWin: Math.min(Math.max(homeWin, 5), 90),
    awayWin: Math.min(Math.max(awayWin, 5), 90),
    draw   : Math.min(Math.max(draw,    5), 60),
    over25 : Math.min(Math.max(over25,  5), 90),
    under25: Math.min(Math.max(100 - over25, 5), 90),
    btts   : Math.min(Math.max(btts,    5), 90),
    noBtts : Math.min(Math.max(100 - btts, 5), 90),
  };
}

function buildStatsBlock(m: MatchData): string {
  const h   = m.homeStats;
  const a   = m.awayStats;
  const x   = m.h2h;
  const sig = computeSignals(m);

  return [
    `MATCH: ${m.homeTeam} vs ${m.awayTeam} [${m.league}] ${m.kickoff}`,
    `HOME(${m.homeTeam}): forme=${h.form5} V${h.wins5}N${h.draws5}D${h.losses5} +${h.avgScored}/-${h.avgConceded} Over25:${h.over25Count} BTTS:${h.bttsCount} CS:${h.cleanSheets}`,
    `AWAY(${m.awayTeam}): forme=${a.form5} V${a.wins5}N${a.draws5}D${a.losses5} +${a.avgScored}/-${a.avgConceded} Over25:${a.over25Count} BTTS:${a.bttsCount} CS:${a.cleanSheets}`,
    `H2H: ${x.totalMatches}matchs homeWin=${x.homeWinPct}% draw=${x.drawPct}% awayWin=${x.awayWinPct}% Over25:${x.over25H2H} BTTS:${x.bttsH2H}`,
    `ODDS: homeML=${m.homeML} awayML=${m.awayML} OU=${m.overUnder}`,
    `SIGNALS: homeWin=${sig.homeWin} awayWin=${sig.awayWin} draw=${sig.draw} over25=${sig.over25} under25=${sig.under25} btts=${sig.btts} noBtts=${sig.noBtts}`,
  ].join("\n");
}

function localFallback(m: MatchData): { market: string; choice: string; confidence: number; reason: string } {
  const sig = computeSignals(m);
  const candidates = [
    { market: "1X2", choice: `Victoire ${m.homeTeam}`, confidence: sig.homeWin,  key: "homeWin" },
    { market: "1X2", choice: `Victoire ${m.awayTeam}`, confidence: sig.awayWin,  key: "awayWin" },
    { market: "1X2", choice: "Match nul",               confidence: sig.draw,     key: "draw" },
    { market: "Plus/Moins buts", choice: "Plus de 2.5 buts",   confidence: sig.over25,  key: "over25" },
    { market: "Plus/Moins buts", choice: "Moins de 2.5 buts",  confidence: sig.under25, key: "under25" },
    { market: "Les deux équipes marquent", choice: "Oui",       confidence: sig.btts,    key: "btts" },
    { market: "Les deux équipes marquent", choice: "Non",       confidence: sig.noBtts,  key: "noBtts" },
  ];
  const best = candidates.reduce((a, b) => a.confidence >= b.confidence ? a : b);
  const h = m.homeStats, a_ = m.awayStats, x = m.h2h;
  const reasons: Record<string, string> = {
    homeWin : `${m.homeTeam} forme ${h.form5}, ${h.wins5}V/5, cotes favorisent domicile`,
    awayWin : `${m.awayTeam} forme ${a_.form5}, ${a_.wins5}V/5, cotes favorisent extérieur`,
    draw    : `H2H ${x.drawPct}% nuls, équipes équilibrées`,
    over25  : `Moy. buts dom. ${h.avgScored}/${h.avgConceded}, ext. ${a_.avgScored}/${a_.avgConceded}`,
    under25 : `Défenses solides, ${h.cleanSheets}/${a_.cleanSheets} CS récents`,
    btts    : `Les deux équipes ont marqué dans ${(h.bttsCount + a_.bttsCount) / 2}/5 matchs récents`,
    noBtts  : `CS fréquents : dom. ${h.cleanSheets}/5, ext. ${a_.cleanSheets}/5`,
  };
  return { ...best, reason: reasons[best.key] ?? "" };
}

async function analyseWithAI(m: MatchData): Promise<{ market: string; choice: string; confidence: number; reason: string }> {
  if (!GROQ_KEY) return localFallback(m);
  const statsBlock = buildStatsBlock(m);

  const prompt = `Tu es un analyste football expert. Voici les données d'un match.
${statsBlock}

Retourne UNIQUEMENT un JSON valide :
{"market":"Plus/Moins buts","choice":"Plus de 2.5 buts","confidence":72,"reason":"Over25 fréquent (7/10), moy. buts ESPN 3.1"}

Champs obligatoires:
- market: "1X2" | "Plus/Moins buts" | "Les deux équipes marquent"
- choice: option la plus probable
- confidence: nombre entre 51 et 89
- reason: une phrase courte avec les stats clés

Choisis le marché avec le signal le plus fort et le plus fiable. Réponds UNIQUEMENT avec le JSON.`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 150,
      }),
    });
    if (!r.ok) return localFallback(m);
    const data: any = await r.json();
    const raw     = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const jsonStr = raw.match(/\{[\s\S]*?\}/)?.[0] ?? "{}";
    const parsed  = JSON.parse(jsonStr);
    if (!parsed.market || !parsed.choice || !parsed.confidence) return localFallback(m);
    return parsed;
  } catch {
    return localFallback(m);
  }
}

function confBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled) + ` ${pct}%`;
}

async function runPipeline(chatId: number, count: number): Promise<void> {
  const safeCount = Math.max(1, Math.min(10, count));
  await typing(chatId);

  const typingLoop = keepTyping(chatId, 120_000);

  const matches = await scrapeUpcomingMatches(safeCount, async (msg) => {
    await send(chatId, msg);
  });

  if (!matches.length) {
    await send(chatId, "😕 Aucun match à venir trouvé aujourd'hui sur ESPN. Réessaie plus tard ou tape <b>programme</b> pour voir les matchs disponibles.");
    return;
  }

  await send(chatId, `🧠 Analyse IA en cours pour <b>${matches.length} match(s)</b>...`);

  const pronos: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m   = matches[i];
    const res = await analyseWithAI(m);
    pronos.push(
      `${i + 1}. ⚽ <b>${m.homeTeam} vs ${m.awayTeam}</b>\n` +
      `👉 ${res.market} → <b>${res.choice}</b>\n` +
      confBar(res.confidence) + "\n" +
      `📊 ${res.reason}`
    );
  }

  const header = `⚽ <b>PRONOSTICS DU JOUR — ${matches.length} match(s)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const footer = `\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>Analyse statistique ESPN + IA. Jouer responsable.</i>`;
  await send(chatId, header + pronos.join("\n\n") + footer);
}

// ══════════════════════════════════════════════════════
//  HANDLE — ROUTEUR UNIVERSEL
// ══════════════════════════════════════════════════════

const GREETING = /^(bonjour|bonsoir|salut|hello|hi|hey|cc|coucou|yo|wesh|salam|bjr|bj|slt|ola|hola|gm|good\s?morning|good\s?evening|good\s?night|bonne\s?nuit|soir|jour|matin|bonne\s?journée)[\s!.,?]*$/i;

const GREET_REPLIES = [
  "👋 Salut ! Je suis FootBot, ton assistant football IA.\n\nTu peux me demander :\n• 📊 <b>Pronostics</b> pour les matchs du jour\n• 🏆 <b>Classement</b> d'une ligue\n• ⚡ <b>Scores live</b> en ce moment\n• 📅 <b>Programme</b> du jour\n• 👤 Infos sur un <b>joueur</b>\n• ⚽ Infos sur une <b>équipe</b>\n• 📰 <b>Actualités</b> foot\n• ❓ N'importe quelle <b>question football</b> !",
  "⚽ Hey ! Je suis là pour tout ce qui touche au foot.\n\nDemande-moi ce que tu veux : classement, scores, actu, pronostics, infos joueur... Je suis là !",
  "🔥 Salut ! Prêt à parler foot ?\n\nEnvoie-moi ta question — pronostics, classement Ligue 1, qui est le meilleur buteur, scores live... Je m'occupe de tout !",
];

function extractNumber(text: string): number | null {
  const m = text.match(/\b([1-9]|10)\b/);
  return m ? parseInt(m[1], 10) : null;
}

async function handle(chatId: number, raw: string): Promise<void> {
  const lower = raw.toLowerCase().trim();
  const phase = await loadPhase(chatId);

  // ── Si on attend un chiffre de confirmation ──────
  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPipeline(chatId, num);
      return;
    }
    // sinon on continue le routage normal (l'utilisateur a posé une autre question)
    await savePhase(chatId, "idle");
  }

  // ── Salutation simple rapide ─────────────────────
  if (GREETING.test(lower)) {
    await send(chatId, GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)]);
    return;
  }

  // ── Commandes slash directes ─────────────────────
  if (lower.startsWith("/start") || lower.startsWith("/help") || lower === "/") {
    await send(chatId, GREET_REPLIES[0]);
    return;
  }
  if (lower.startsWith("/live") || lower === "live") {
    await handleScoresLive(chatId); return;
  }
  if (lower.startsWith("/programme") || lower === "programme" || lower === "matchs du jour" || lower === "aujourd'hui") {
    await handleProgramme(chatId); return;
  }
  if (lower.startsWith("/actu") || lower === "actualités" || lower === "actualites" || lower === "news") {
    await handleActualites(chatId); return;
  }

  // ── Détection d'intention via Groq ───────────────
  await typing(chatId);
  const intent = await detectIntent(raw);
  console.log("[INTENT]", JSON.stringify(intent));

  switch (intent.intent) {

    case "salutation":
      await send(chatId, GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)]);
      break;

    case "nombre": {
      const num = intent.count ?? extractNumber(raw);
      if (num !== null) {
        await savePhase(chatId, "idle");
        await runPipeline(chatId, num);
      } else {
        await savePhase(chatId, "awaiting_count");
        await send(chatId, "⚽ Combien de matchs tu veux analyser ? (1 à 10)");
      }
      break;
    }

    case "pronostics": {
      const num = intent.count ?? extractNumber(raw);
      if (num !== null) {
        await savePhase(chatId, "idle");
        await runPipeline(chatId, num);
      } else {
        await savePhase(chatId, "awaiting_count");
        await send(chatId, "⚽ Combien de matchs tu veux que j'analyse ? (1 à 10)");
      }
      break;
    }

    case "classement":
      await handleClassement(chatId, intent.league ?? detectLeague(raw), raw);
      break;

    case "scores_live":
      await handleScoresLive(chatId);
      break;

    case "programme":
      await handleProgramme(chatId);
      break;

    case "equipe":
      await handleEquipe(chatId, intent.team ?? "", raw);
      break;

    case "joueur":
      await handleJoueur(chatId, intent.player ?? "", raw);
      break;

    case "actualites":
      await handleActualites(chatId);
      break;

    case "h2h":
      await handleH2H(chatId, intent.team ?? "", intent.team2 ?? "", raw);
      break;

    default:
      // Question football générale → Groq répond directement
      await groqGeneralQA(chatId, raw);
      break;
  }
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot v6 ⚽ Assistant Football Universel — ESPN + IA Groq");

  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
