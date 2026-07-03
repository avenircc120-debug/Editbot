// ═══════════════════════════════════════════════════════
//  FOOTBOT — Pipeline Pronostics Sportifs IA (v2)
//  Architecture : Scraping → Analyse IA → Sortie directe
//  SofaScore (unofficial) + Groq AI · Mémoire Supabase
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG       = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── SofaScore headers ──────────────────────────────────
const SF: Record<string, string> = {
  "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept"         : "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Referer"        : "https://www.sofascore.com/",
  "Origin"         : "https://www.sofascore.com",
  "Cache-Control"  : "no-cache",
};

const LEAGUES: Record<string, { id: number; name: string }> = {
  ucl       : { id: 7,  name: "Champions League" },
  premier   : { id: 17, name: "Premier League" },
  laliga    : { id: 8,  name: "La Liga" },
  ligue1    : { id: 34, name: "Ligue 1" },
  bundesliga: { id: 35, name: "Bundesliga" },
  seriea    : { id: 23, name: "Serie A" },
};

const MAJOR = new Set([7, 17, 8, 34, 35, 23, 679, 44, 771, 242, 119]);

// ── SofaScore fetch ────────────────────────────────────
async function sfFetch(path: string): Promise<any> {
  try {
    const r = await fetch(`https://api.sofascore.com/api/v1${path}`, { headers: SF });
    if (r.ok) return r.json();
    console.error(`SofaScore ${r.status} on ${path}`);
    return null;
  } catch (e) {
    console.error(`SofaScore error on ${path}:`, e);
    return null;
  }
}

const todayStr = () => new Date().toISOString().split("T")[0];

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit",
  });

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("fr-FR", {
    timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric",
  });

// ══════════════════════════════════════════════════════
//  TELEGRAM — Envoi de messages
// ══════════════════════════════════════════════════════
async function send(chatId: number, text: string): Promise<void> {
  await fetch(`${TG}/sendMessage`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(console.error);
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 1 — SCRAPING : Récupération des données
// ══════════════════════════════════════════════════════

interface MatchData {
  id      : number;
  homeTeam: string;
  awayTeam: string;
  league  : string;
  kickoff : string;
  homeForm: string;
  awayForm: string;
  h2h     : string;
  homeGoalsAvg: number;
  awayGoalsAvg: number;
  homeWinPct  : number;
  awayWinPct  : number;
  drawPct     : number;
}

async function scrapeUpcomingMatches(count: number): Promise<MatchData[]> {
  const today = todayStr();
  const data  = await sfFetch(`/sport/football/scheduled-events/${today}`);
  const events: any[] = data?.events ?? [];

  // Filtrer sur les grandes ligues, prendre les N premiers à venir
  const upcoming = events
    .filter((e: any) =>
      MAJOR.has(e.tournament?.uniqueTournament?.id) &&
      e.status?.type === "notstarted"
    )
    .slice(0, count);

  // Pour chaque match, scraper les stats en parallèle
  const matchDataList = await Promise.all(upcoming.map(scrapeMatchStats));
  return matchDataList.filter(Boolean) as MatchData[];
}

async function scrapeMatchStats(event: any): Promise<MatchData | null> {
  try {
    const matchId  = event.id;
    const homeTeam = event.homeTeam?.name ?? "?";
    const awayTeam = event.awayTeam?.name ?? "?";
    const league   = event.tournament?.name ?? "?";
    const kickoff  = event.startTimestamp ? fmtTime(event.startTimestamp) : "?";
    const homeId   = event.homeTeam?.id;
    const awayId   = event.awayTeam?.id;

    // Requêtes parallèles : form domicile, form extérieur, h2h
    const [homeFormData, awayFormData, h2hData] = await Promise.all([
      homeId ? sfFetch(`/team/${homeId}/events/last/0`) : Promise.resolve(null),
      awayId ? sfFetch(`/team/${awayId}/events/last/0`) : Promise.resolve(null),
      sfFetch(`/event/${matchId}/h2h/events`),
    ]);

    const homeForm = extractForm(homeFormData?.events ?? [], homeId);
    const awayForm = extractForm(awayFormData?.events ?? [], awayId);
    const { h2hStr, homeWinPct, awayWinPct, drawPct } = extractH2H(h2hData, homeTeam, awayTeam);
    const homeGoalsAvg = calcGoalsAvg(homeFormData?.events ?? [], homeId, "home");
    const awayGoalsAvg = calcGoalsAvg(awayFormData?.events ?? [], awayId, "away");

    return {
      id: matchId, homeTeam, awayTeam, league, kickoff,
      homeForm, awayForm, h2h: h2hStr,
      homeGoalsAvg, awayGoalsAvg,
      homeWinPct, awayWinPct, drawPct,
    };
  } catch (e) {
    console.error("scrapeMatchStats error:", e);
    return null;
  }
}

function extractForm(events: any[], teamId: number): string {
  if (!events?.length) return "N/A";
  return events
    .slice(-5)
    .map((e: any) => {
      const isHome   = e.homeTeam?.id === teamId;
      const homeScore = e.homeScore?.current ?? 0;
      const awayScore = e.awayScore?.current ?? 0;
      if (isHome) return homeScore > awayScore ? "V" : homeScore < awayScore ? "D" : "N";
      return awayScore > homeScore ? "V" : awayScore < homeScore ? "D" : "N";
    })
    .join("-");
}

function extractH2H(
  data: any,
  homeTeam: string,
  awayTeam: string
): { h2hStr: string; homeWinPct: number; awayWinPct: number; drawPct: number } {
  const empty = { h2hStr: "Pas de h2h", homeWinPct: 33, awayWinPct: 33, drawPct: 34 };
  if (!data) return empty;

  const events: any[] = [
    ...(data.previousEvents ?? []),
    ...(data.homeEvents ?? []),
    ...(data.awayEvents ?? []),
  ].slice(-10);

  if (!events.length) return empty;

  let hw = 0, aw = 0, d = 0;
  const lines: string[] = [];

  for (const e of events.slice(-5)) {
    const hn = e.homeTeam?.name ?? "?";
    const an = e.awayTeam?.name ?? "?";
    const hs = e.homeScore?.current ?? 0;
    const as_ = e.awayScore?.current ?? 0;
    const res = hs > as_ ? hn : hs < as_ ? an : "Nul";
    lines.push(`${hn} ${hs}-${as_} ${an} (${fmtDate(e.startTimestamp)})`);
    const isHomeHome = hn.toLowerCase().includes(homeTeam.toLowerCase().slice(0, 4));
    if (hs > as_) isHomeHome ? hw++ : aw++;
    else if (hs < as_) isHomeHome ? aw++ : hw++;
    else d++;
  }

  const total = hw + aw + d || 1;
  return {
    h2hStr   : lines.join(" | "),
    homeWinPct: Math.round((hw / total) * 100),
    awayWinPct: Math.round((aw / total) * 100),
    drawPct   : Math.round((d  / total) * 100),
  };
}

function calcGoalsAvg(events: any[], teamId: number, side: "home" | "away"): number {
  if (!events?.length) return 1.2;
  const last5 = events.slice(-5);
  const total = last5.reduce((acc: number, e: any) => {
    const isHome = e.homeTeam?.id === teamId;
    const scored = isHome ? (e.homeScore?.current ?? 0) : (e.awayScore?.current ?? 0);
    return acc + scored;
  }, 0);
  return parseFloat((total / last5.length).toFixed(2));
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 2 — ANALYSE IA : Groq + Prompt système strict
// ══════════════════════════════════════════════════════

interface Pronostic {
  index    : number;
  homeTeam : string;
  awayTeam : string;
  market   : string;
  choice   : string;
  confidence: number;
}

async function analyseWithAI(matches: MatchData[]): Promise<Pronostic[]> {
  if (!matches.length) return [];

  const matchesBlock = matches.map((m, i) => `
MATCH ${i + 1}: ${m.homeTeam} vs ${m.awayTeam}
- Ligue: ${m.league} | Heure: ${m.kickoff}
- Forme ${m.homeTeam} (5 derniers): ${m.homeForm}
- Forme ${m.awayTeam} (5 derniers): ${m.awayForm}
- H2H récent: ${m.h2h}
- Moy. buts ${m.homeTeam}: ${m.homeGoalsAvg} | Moy. buts ${m.awayTeam}: ${m.awayGoalsAvg}
- H2H stats: ${m.homeTeam} gagne ${m.homeWinPct}% | Nul ${m.drawPct}% | ${m.awayTeam} gagne ${m.awayWinPct}%
`.trim()).join("\n\n");

  const systemPrompt = `Tu es un analyste sportif expert en paris sportifs.
Tu reçois des données réelles (forme, h2h, statistiques) pour plusieurs matchs.
Pour chaque match, tu dois identifier le marché ayant la PLUS FORTE probabilité statistique parmi :
  - Résultat 1X2 (Victoire domicile / Nul / Victoire extérieur)
  - Les deux équipes marquent (BTTSoui/non)
  - Plus/Moins de 2.5 buts
  - Double chance (1X / X2 / 12)

RÈGLES STRICTES :
1. Analyse les stats réelles fournis pour chaque match.
2. Choisis UN seul marché par match, celui avec la probabilité la plus élevée.
3. Donne une confiance entre 55% et 92% selon la force du signal statistique.
4. Réponds UNIQUEMENT avec un JSON valide, aucun autre texte, format exact :
[
  {"index":1,"homeTeam":"Nom","awayTeam":"Nom","market":"Marché","choice":"Pronostic","confidence":XX},
  ...
]`;

  const userMsg = `Analyse ces ${matches.length} matchs et génère les pronostics :\n\n${matchesBlock}`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method : "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        model      : "llama-3.3-70b-versatile",
        temperature: 0.3,
        max_tokens : 1500,
        messages   : [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMsg },
        ],
      }),
    });
    const json = await r.json();
    const raw  = json.choices?.[0]?.message?.content ?? "[]";

    // Extraire le JSON même si le modèle ajoute du texte autour
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("AI response not parseable:", raw);
      return [];
    }
    return JSON.parse(jsonMatch[0]) as Pronostic[];
  } catch (e) {
    console.error("analyseWithAI error:", e);
    return [];
  }
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 3 — SORTIE : Format imposé, rien d'autre
// ══════════════════════════════════════════════════════

function formatPronostics(pronostics: Pronostic[]): string {
  if (!pronostics.length) return "❌ Aucun pronostic disponible pour l'instant.";
  return pronostics
    .map((p, i) =>
      `${i + 1}. ${p.homeTeam} vs ${p.awayTeam}\n` +
      `👉 Marché : ${p.market} | Choix : ${p.choice} | Confiance : ${p.confidence}%`
    )
    .join("\n\n");
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRINCIPAL — Scraping → IA → Sortie
// ══════════════════════════════════════════════════════

async function runPronosticPipeline(chatId: number, count: number): Promise<void> {
  // Scraping
  const matches = await scrapeUpcomingMatches(count);

  if (!matches.length) {
    await send(chatId, "❌ Aucun match trouvé pour aujourd'hui dans les grandes ligues.");
    return;
  }

  // Analyse IA
  const pronostics = await analyseWithAI(matches.slice(0, count));

  // Sortie directe
  const output = formatPronostics(pronostics);
  await send(chatId, output);
}

// ══════════════════════════════════════════════════════
//  COMMANDES SIMPLES (live, auj, classement, etc.)
// ══════════════════════════════════════════════════════

async function cmdLive(chatId: number): Promise<void> {
  const data   = await sfFetch(`/sport/football/events/live`);
  const events: any[] = data?.events ?? [];
  const major  = events.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id));
  if (!major.length) { await send(chatId, "Aucun match en direct dans les grandes ligues."); return; }
  const lines = major.slice(0, 10).map((e: any) => {
    const hn = e.homeTeam?.name ?? "?";
    const an = e.awayTeam?.name ?? "?";
    const hs = e.homeScore?.current ?? 0;
    const as_ = e.awayScore?.current ?? 0;
    const min = e.time?.played ?? e.time?.currentPeriodStartTimestamp ? "?" : "";
    return `⚽ ${hn} ${hs} - ${as_} ${an} (${e.tournament?.name ?? "?"})`;
  });
  await send(chatId, `🔴 <b>Matchs en direct</b>\n\n${lines.join("\n")}`);
}

async function cmdToday(chatId: number): Promise<void> {
  const today  = todayStr();
  const data   = await sfFetch(`/sport/football/scheduled-events/${today}`);
  const events: any[] = data?.events ?? [];
  const major  = events.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id));
  if (!major.length) { await send(chatId, "Aucun match prévu aujourd'hui dans les grandes ligues."); return; }
  const lines = major.slice(0, 15).map((e: any) =>
    `${fmtTime(e.startTimestamp)} — ${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`
  );
  await send(chatId, `📅 <b>Matchs du jour</b>\n\n${lines.join("\n")}`);
}

async function cmdStanding(chatId: number, leagueKey: string): Promise<void> {
  const lg = LEAGUES[leagueKey];
  if (!lg) {
    const keys = Object.keys(LEAGUES).join(", ");
    await send(chatId, `Ligue inconnue. Disponibles : ${keys}`);
    return;
  }

  // Chercher la saison courante
  const seasons = await sfFetch(`/unique-tournament/${lg.id}/seasons`);
  const seasonId = seasons?.seasons?.[0]?.id;
  if (!seasonId) { await send(chatId, "Impossible de récupérer la saison."); return; }

  const data  = await sfFetch(`/unique-tournament/${lg.id}/season/${seasonId}/standings/total`);
  const rows: any[] = data?.standings?.[0]?.rows ?? [];
  if (!rows.length) { await send(chatId, "Classement non disponible."); return; }

  const lines = rows.slice(0, 10).map((r: any) =>
    `${r.position}. ${r.team?.name} — ${r.points} pts (${r.wins}V ${r.draws}N ${r.losses}D)`
  );
  await send(chatId, `🏆 <b>${lg.name} — Classement</b>\n\n${lines.join("\n")}`);
}

async function cmdTeam(chatId: number, name: string): Promise<void> {
  const search = await sfFetch(`/search/teams?q=${encodeURIComponent(name)}`);
  const team   = search?.teams?.[0];
  if (!team) { await send(chatId, `Équipe "${name}" introuvable.`); return; }

  const [info, events] = await Promise.all([
    sfFetch(`/team/${team.id}`),
    sfFetch(`/team/${team.id}/events/last/0`),
  ]);

  const form = extractForm(events?.events ?? [], team.id);
  const t    = info?.team ?? team;
  await send(chatId,
    `🏟 <b>${t.name}</b>\n` +
    `Pays : ${t.country?.name ?? "?"}\n` +
    `Forme (5 derniers) : ${form}`
  );
}

async function cmdPlayer(chatId: number, name: string): Promise<void> {
  const search = await sfFetch(`/search/players?q=${encodeURIComponent(name)}`);
  const player = search?.players?.[0]?.player ?? search?.players?.[0];
  if (!player) { await send(chatId, `Joueur "${name}" introuvable.`); return; }

  await send(chatId,
    `👤 <b>${player.name}</b>\n` +
    `Équipe : ${player.team?.name ?? "N/A"}\n` +
    `Nationalité : ${player.country?.name ?? "?"}\n` +
    `Position : ${player.position ?? "?"}`
  );
}

async function cmdH2H(chatId: number, team1: string, team2: string): Promise<void> {
  const [s1, s2] = await Promise.all([
    sfFetch(`/search/teams?q=${encodeURIComponent(team1)}`),
    sfFetch(`/search/teams?q=${encodeURIComponent(team2)}`),
  ]);
  const t1 = s1?.teams?.[0];
  const t2 = s2?.teams?.[0];
  if (!t1 || !t2) { await send(chatId, "Équipe(s) introuvable(s)."); return; }

  // Trouver un event commun pour le h2h
  const today  = todayStr();
  const sched  = await sfFetch(`/sport/football/scheduled-events/${today}`);
  const ev     = (sched?.events ?? []).find((e: any) =>
    (e.homeTeam?.id === t1.id && e.awayTeam?.id === t2.id) ||
    (e.homeTeam?.id === t2.id && e.awayTeam?.id === t1.id)
  );

  if (ev) {
    const h2hData = await sfFetch(`/event/${ev.id}/h2h/events`);
    const { h2hStr } = extractH2H(h2hData, t1.name, t2.name);
    await send(chatId, `⚔️ <b>H2H : ${t1.name} vs ${t2.name}</b>\n\n${h2hStr}`);
  } else {
    await send(chatId, `${t1.name} vs ${t2.name} — pas de confrontation trouvée aujourd'hui.`);
  }
}

async function cmdSinglePronostic(chatId: number, team1: string, team2: string): Promise<void> {
  // Chercher le match aujourd'hui
  const today = todayStr();
  const sched = await sfFetch(`/sport/football/scheduled-events/${today}`);
  const event = (sched?.events ?? []).find((e: any) =>
    (e.homeTeam?.name?.toLowerCase().includes(team1.toLowerCase()) &&
     e.awayTeam?.name?.toLowerCase().includes(team2.toLowerCase())) ||
    (e.homeTeam?.name?.toLowerCase().includes(team2.toLowerCase()) &&
     e.awayTeam?.name?.toLowerCase().includes(team1.toLowerCase()))
  );

  if (!event) {
    await send(chatId, `Match ${team1} vs ${team2} introuvable dans les matchs du jour.`);
    return;
  }

  const matchStats = await scrapeMatchStats(event);
  if (!matchStats) { await send(chatId, "Impossible de récupérer les stats du match."); return; }

  const pronostics = await analyseWithAI([matchStats]);
  const output     = formatPronostics(pronostics);
  await send(chatId, output);
}

async function cmdHelp(chatId: number): Promise<void> {
  await send(chatId,
    `⚽ <b>FootBot — Commandes</b>\n\n` +
    `/pronos [N] — N pronostics du jour (ex: /pronos 5)\n` +
    `/live — Matchs en direct\n` +
    `/auj — Matchs du jour\n` +
    `/classement [ligue] — Classement (premier, laliga, ligue1, bundesliga, seriea, ucl)\n` +
    `/equipe [nom] — Infos + forme d'une équipe\n` +
    `/joueur [nom] — Stats d'un joueur\n` +
    `/h2h [e1] vs [e2] — Confrontations directes\n` +
    `/pronostic [e1] vs [e2] — Pronostic IA pour un match précis`
  );
}

// ══════════════════════════════════════════════════════
//  ROUTEUR DE COMMANDES
// ══════════════════════════════════════════════════════

async function handle(chatId: number, text: string): Promise<void> {
  const raw  = text.trim();
  const lower = raw.toLowerCase();

  // /pronos N  ou  /pronos  (défaut 5)
  const pronosMatch = lower.match(/^\/pronos(?:tics?)?\s*(\d+)?/);
  if (pronosMatch) {
    const n = Math.min(Math.max(parseInt(pronosMatch[1] ?? "5", 10), 1), 10);
    await runPronosticPipeline(chatId, n);
    return;
  }

  // /pronostic eq1 vs eq2
  if (lower.startsWith("/pronostic ")) {
    const rest    = raw.slice(11).trim();
    const vsMatch = rest.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (vsMatch) { await cmdSinglePronostic(chatId, vsMatch[1].trim(), vsMatch[2].trim()); return; }
  }

  if (lower === "/live")                { await cmdLive(chatId); return; }
  if (lower === "/auj")                 { await cmdToday(chatId); return; }
  if (lower === "/start" || lower === "/help") { await cmdHelp(chatId); return; }

  // /classement [ligue]
  const standMatch = lower.match(/^\/classement\s*(\w+)?/);
  if (standMatch) {
    await cmdStanding(chatId, standMatch[1] ?? "premier");
    return;
  }

  // /equipe [nom]
  const teamMatch = raw.match(/^\/equipe\s+(.+)/i);
  if (teamMatch) { await cmdTeam(chatId, teamMatch[1].trim()); return; }

  // /joueur [nom]
  const playerMatch = raw.match(/^\/joueur\s+(.+)/i);
  if (playerMatch) { await cmdPlayer(chatId, playerMatch[1].trim()); return; }

  // /h2h eq1 vs eq2
  const h2hMatch = raw.match(/^\/h2h\s+(.+?)\s+vs\s+(.+)/i);
  if (h2hMatch) { await cmdH2H(chatId, h2hMatch[1].trim(), h2hMatch[2].trim()); return; }

  // Texte libre — guide vers /pronos
  await send(chatId, `Utilisez /pronos 5 pour recevoir 5 pronostics IA ou /help pour la liste des commandes.`);
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

if (!WEBHOOK_SECRET) {
  console.warn("[SECURITY] TELEGRAM_WEBHOOK_SECRET non configuré — toutes les requêtes POST sont acceptées.");
}

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot ⚽ — Pipeline Pronostics Sportifs IA v2");

  if (WEBHOOK_SECRET) {
    const sig = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`Unauthorized webhook — ${req.headers.get("x-forwarded-for") ?? "unknown"}`);
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
