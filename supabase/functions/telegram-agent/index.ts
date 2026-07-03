// ═══════════════════════════════════════════════════════
//  FOOTBOT — Pipeline Pronostics Sportifs IA (v3)
//  Architecture : Scraping → Analyse IA → Sortie directe
//  Flow conversationnel : détection intention → question → pipeline
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

// ══════════════════════════════════════════════════════
//  SESSION — État conversationnel en mémoire + Supabase
// ══════════════════════════════════════════════════════

type Phase = "idle" | "awaiting_count";

interface Session {
  chatId : number;
  phase  : Phase;
}

// Cache local (durée de vie de la requête Edge Function)
const sessionCache = new Map<number, Session>();

function getSession(chatId: number): Session {
  if (!sessionCache.has(chatId)) {
    sessionCache.set(chatId, { chatId, phase: "idle" });
  }
  return sessionCache.get(chatId)!;
}

function sbHeaders(): Record<string, string> {
  return {
    "apikey"       : SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type" : "application/json",
    "Prefer"       : "return=representation",
  };
}

async function loadPhase(chatId: number): Promise<Phase> {
  if (!SB_URL || !SB_KEY) return "idle";
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase`,
      { headers: sbHeaders() }
    );
    if (!r.ok) return "idle";
    const rows: any[] = await r.json();
    return (rows?.[0]?.phase as Phase) ?? "idle";
  } catch { return "idle"; }
}

async function savePhase(chatId: number, phase: Phase): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method : "POST",
      headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
      body   : JSON.stringify({ chat_id: chatId, phase }),
    });
  } catch { /* non bloquant */ }
}

// ── SofaScore fetch ────────────────────────────────────
async function sfFetch(path: string): Promise<any> {
  try {
    const r = await fetch(`https://api.sofascore.com/api/v1${path}`, { headers: SF });
    if (r.ok) return r.json();
    return null;
  } catch { return null; }
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
//  TELEGRAM — Envoi messages
// ══════════════════════════════════════════════════════
async function send(chatId: number, text: string): Promise<void> {
  await fetch(`${TG}/sendMessage`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(console.error);
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 1 — SCRAPING
// ══════════════════════════════════════════════════════

interface MatchData {
  id          : number;
  homeTeam    : string;
  awayTeam    : string;
  league      : string;
  kickoff     : string;
  homeForm    : string;
  awayForm    : string;
  h2h         : string;
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

  const upcoming = events
    .filter((e: any) =>
      MAJOR.has(e.tournament?.uniqueTournament?.id) &&
      e.status?.type === "notstarted"
    )
    .slice(0, count * 2); // marge en cas d'échec de scraping

  const matchDataList = await Promise.all(upcoming.map(scrapeMatchStats));
  return matchDataList.filter(Boolean).slice(0, count) as MatchData[];
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

    const [homeFormData, awayFormData, h2hData] = await Promise.all([
      homeId ? sfFetch(`/team/${homeId}/events/last/0`) : Promise.resolve(null),
      awayId ? sfFetch(`/team/${awayId}/events/last/0`) : Promise.resolve(null),
      sfFetch(`/event/${matchId}/h2h/events`),
    ]);

    const homeForm = extractForm(homeFormData?.events ?? [], homeId);
    const awayForm = extractForm(awayFormData?.events ?? [], awayId);
    const { h2hStr, homeWinPct, awayWinPct, drawPct } = extractH2H(h2hData, homeTeam, awayTeam);
    const homeGoalsAvg = calcGoalsAvg(homeFormData?.events ?? [], homeId);
    const awayGoalsAvg = calcGoalsAvg(awayFormData?.events ?? [], awayId);

    return {
      id: matchId, homeTeam, awayTeam, league, kickoff,
      homeForm, awayForm, h2h: h2hStr,
      homeGoalsAvg, awayGoalsAvg,
      homeWinPct, awayWinPct, drawPct,
    };
  } catch { return null; }
}

function extractForm(events: any[], teamId: number): string {
  if (!events?.length) return "N/A";
  return events.slice(-5).map((e: any) => {
    const isHome    = e.homeTeam?.id === teamId;
    const hs        = e.homeScore?.current ?? 0;
    const as_       = e.awayScore?.current ?? 0;
    const scored    = isHome ? hs : as_;
    const conceded  = isHome ? as_ : hs;
    if (scored > conceded) return "V";
    if (scored < conceded) return "D";
    return "N";
  }).join("-");
}

function extractH2H(
  data: any,
  homeTeam: string,
  awayTeam: string,
): { h2hStr: string; homeWinPct: number; awayWinPct: number; drawPct: number } {
  const empty = { h2hStr: "Pas de h2h disponible", homeWinPct: 33, awayWinPct: 33, drawPct: 34 };
  if (!data) return empty;

  const events: any[] = [
    ...(data.previousEvents ?? []),
    ...(data.homeEvents ?? []),
    ...(data.awayEvents ?? []),
  ].slice(-10);

  if (!events.length) return empty;

  let hw = 0, aw = 0, d = 0;
  const lines: string[] = [];
  const homeLower = homeTeam.toLowerCase().slice(0, 4);

  for (const e of events.slice(-5)) {
    const hn  = e.homeTeam?.name ?? "?";
    const an  = e.awayTeam?.name ?? "?";
    const hs  = e.homeScore?.current ?? 0;
    const as_ = e.awayScore?.current ?? 0;
    lines.push(`${hn} ${hs}-${as_} ${an} (${fmtDate(e.startTimestamp)})`);
    const isHomeHome = hn.toLowerCase().includes(homeLower);
    if (hs > as_) { isHomeHome ? hw++ : aw++; }
    else if (hs < as_) { isHomeHome ? aw++ : hw++; }
    else { d++; }
  }

  const total = hw + aw + d || 1;
  return {
    h2hStr    : lines.join(" | "),
    homeWinPct: Math.round((hw / total) * 100),
    awayWinPct: Math.round((aw / total) * 100),
    drawPct   : Math.round((d  / total) * 100),
  };
}

function calcGoalsAvg(events: any[], teamId: number): number {
  if (!events?.length) return 1.2;
  const last5 = events.slice(-5);
  const total = last5.reduce((acc: number, e: any) => {
    const isHome = e.homeTeam?.id === teamId;
    return acc + (isHome ? (e.homeScore?.current ?? 0) : (e.awayScore?.current ?? 0));
  }, 0);
  return parseFloat((total / last5.length).toFixed(2));
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 2 — ANALYSE IA (Groq)
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

  // Prompt compact pour minimiser les tokens consommés
  const systemPrompt = `Expert paris sportifs. Pour chaque match donné, choisis le marché le plus probable (1X2, BTTS, +/-2.5 buts, Double chance). Réponds UNIQUEMENT en JSON, sans texte autour :
[{"index":1,"homeTeam":"X","awayTeam":"Y","market":"Marché","choice":"Pronostic","confidence":75}]`;

  // Données compressées : seulement l'essentiel pour l'IA
  const compactBlock = matches.map((m, i) =>
    `M${i + 1}:${m.homeTeam} vs ${m.awayTeam}(${m.league}) forme:${m.homeForm}/${m.awayForm} h2h:${m.homeWinPct}%/${m.drawPct}%/${m.awayWinPct}% buts:${m.homeGoalsAvg}/${m.awayGoalsAvg}`
  ).join(" | ");

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method : "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        model      : "llama-3.1-8b-instant", // Modèle léger — 8× moins de crédits
        temperature: 0.1,
        max_tokens : 300,                    // Juste assez pour le JSON de sortie
        messages   : [
          { role: "system", content: systemPrompt },
          { role: "user",   content: compactBlock },
        ],
      }),
    });
    const json = await r.json();
    if (json.error) { console.error("Groq error:", json.error.message); return []; }
    const raw  = json.choices?.[0]?.message?.content ?? "[]";
    const m    = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    return JSON.parse(m[0]) as Pronostic[];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 3 — SORTIE FORMAT IMPOSÉ
// ══════════════════════════════════════════════════════

function formatPronostics(pronostics: Pronostic[]): string {
  if (!pronostics.length) return "❌ Aucun pronostic disponible pour l'instant. Réessayez dans quelques minutes.";
  return pronostics
    .map((p, i) =>
      `${i + 1}. ${p.homeTeam} vs ${p.awayTeam}\n` +
      `👉 Marché : ${p.market} | Choix : ${p.choice} | Confiance : ${p.confidence}%`
    )
    .join("\n\n");
}

// ══════════════════════════════════════════════════════
//  PIPELINE : Scraping → IA → Sortie
// ══════════════════════════════════════════════════════

async function runPronosticPipeline(chatId: number, count: number): Promise<void> {
  await send(chatId, `⏳ Analyse de ${count} match${count > 1 ? "s" : ""} en cours...`);

  const matches    = await scrapeUpcomingMatches(count);
  if (!matches.length) {
    await send(chatId, "❌ Aucun match trouvé dans les grandes ligues aujourd'hui.");
    return;
  }

  const pronostics = await analyseWithAI(matches);
  const output     = formatPronostics(pronostics);
  await send(chatId, output);
}

// ══════════════════════════════════════════════════════
//  DÉTECTION D'INTENTION "PRONOSTIC"
// ══════════════════════════════════════════════════════

const PRONOS_INTENT = /pronos|pronostic|predict|tip|paris|mise|bet|cote|palmarès|analyse/i;

function extractNumberFromText(text: string): number | null {
  const m = text.match(/\b(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n >= 1 && n <= 10) return n;
  return null;
}

// ══════════════════════════════════════════════════════
//  COMMANDES SIMPLES
// ══════════════════════════════════════════════════════

async function cmdLive(chatId: number): Promise<void> {
  const data   = await sfFetch(`/sport/football/events/live`);
  const events: any[] = (data?.events ?? []).filter((e: any) =>
    MAJOR.has(e.tournament?.uniqueTournament?.id)
  );
  if (!events.length) { await send(chatId, "Aucun match en direct dans les grandes ligues."); return; }
  const lines = events.slice(0, 10).map((e: any) =>
    `⚽ ${e.homeTeam?.name} ${e.homeScore?.current ?? 0} - ${e.awayScore?.current ?? 0} ${e.awayTeam?.name} (${e.tournament?.name ?? "?"})`
  );
  await send(chatId, `🔴 <b>Matchs en direct</b>\n\n${lines.join("\n")}`);
}

async function cmdToday(chatId: number): Promise<void> {
  const data   = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
  const events: any[] = (data?.events ?? []).filter((e: any) =>
    MAJOR.has(e.tournament?.uniqueTournament?.id)
  );
  if (!events.length) { await send(chatId, "Aucun match prévu aujourd'hui dans les grandes ligues."); return; }
  const lines = events.slice(0, 15).map((e: any) =>
    `${fmtTime(e.startTimestamp)} — ${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`
  );
  await send(chatId, `📅 <b>Matchs du jour</b>\n\n${lines.join("\n")}`);
}

async function cmdStanding(chatId: number, leagueKey: string): Promise<void> {
  const lg = LEAGUES[leagueKey];
  if (!lg) {
    await send(chatId, `Ligue inconnue. Disponibles : ${Object.keys(LEAGUES).join(", ")}`);
    return;
  }
  const seasons  = await sfFetch(`/unique-tournament/${lg.id}/seasons`);
  const seasonId = seasons?.seasons?.[0]?.id;
  if (!seasonId) { await send(chatId, "Impossible de récupérer la saison."); return; }
  const data = await sfFetch(`/unique-tournament/${lg.id}/season/${seasonId}/standings/total`);
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
    `🏟 <b>${t.name}</b>\nPays : ${t.country?.name ?? "?"}\nForme (5 derniers) : ${form}`
  );
}

async function cmdPlayer(chatId: number, name: string): Promise<void> {
  const search = await sfFetch(`/search/players?q=${encodeURIComponent(name)}`);
  const player = search?.players?.[0]?.player ?? search?.players?.[0];
  if (!player) { await send(chatId, `Joueur "${name}" introuvable.`); return; }
  await send(chatId,
    `👤 <b>${player.name}</b>\nÉquipe : ${player.team?.name ?? "N/A"}\n` +
    `Nationalité : ${player.country?.name ?? "?"}\nPosition : ${player.position ?? "?"}`
  );
}

async function cmdHelp(chatId: number): Promise<void> {
  await send(chatId,
    `⚽ <b>FootBot — Commandes</b>\n\n` +
    `/pronos [N] — N pronostics du jour (ex: /pronos 5)\n` +
    `/live — Matchs en direct\n` +
    `/auj — Matchs du jour\n` +
    `/classement [ligue] — Classement (premier, laliga, ligue1, bundesliga, seriea, ucl)\n` +
    `/equipe [nom] — Infos + forme d'une équipe\n` +
    `/joueur [nom] — Stats d'un joueur`
  );
}

// ══════════════════════════════════════════════════════
//  ROUTEUR PRINCIPAL
// ══════════════════════════════════════════════════════

async function handle(chatId: number, text: string): Promise<void> {
  const raw   = text.trim();
  const lower = raw.toLowerCase();

  // ── Commandes directes ──────────────────────────────

  // /pronos [N]
  const pronosCmd = lower.match(/^\/pronos(?:tics?)?\s*(\d+)?/);
  if (pronosCmd) {
    const n = Math.min(Math.max(parseInt(pronosCmd[1] ?? "5", 10), 1), 10);
    await savePhase(chatId, "idle");
    await runPronosticPipeline(chatId, n);
    return;
  }

  if (lower === "/live")  { await cmdLive(chatId); return; }
  if (lower === "/auj")   { await cmdToday(chatId); return; }
  if (lower === "/start" || lower === "/help") { await cmdHelp(chatId); return; }

  // /classement [ligue]
  const standMatch = lower.match(/^\/classement\s*(\w+)?/);
  if (standMatch) { await cmdStanding(chatId, standMatch[1] ?? "premier"); return; }

  // /equipe [nom]
  const teamMatch = raw.match(/^\/equipe\s+(.+)/i);
  if (teamMatch) { await cmdTeam(chatId, teamMatch[1].trim()); return; }

  // /joueur [nom]
  const playerMatch = raw.match(/^\/joueur\s+(.+)/i);
  if (playerMatch) { await cmdPlayer(chatId, playerMatch[1].trim()); return; }

  // ── Gestion de la phase conversationnelle ───────────
  const phase = await loadPhase(chatId);

  // Phase awaiting_count : l'utilisateur répond au nombre de matchs demandé
  if (phase === "awaiting_count") {
    const num = extractNumberFromText(raw);

    // L'utilisateur a donné un nombre → lancer le pipeline
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, num);
      return;
    }

    // L'utilisateur dit "oui", "ok", "vas-y", etc. → défaut 5 matchs
    if (/^(oui|ok|yes|vas[- ]?y|go|allez|c'est bon|parfait|top|super)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, 5);
      return;
    }

    // L'utilisateur dit "non" → annuler
    if (/^(non|no|annule|annuler|stop|cancel)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await send(chatId, "Demande annulée. Tapez /pronos 5 quand vous voulez.");
      return;
    }

    // Réponse non reconnue → rappeler la question
    await send(chatId, "Donnez un nombre entre 1 et 10 (ou tapez \"non\" pour annuler) :");
    return;
  }

  // ── Phase idle : détecter l'intention "pronostic" ───
  if (PRONOS_INTENT.test(lower)) {
    // L'utilisateur mentionne un nombre dans le même message → lancer directement
    const num = extractNumberFromText(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, num);
      return;
    }

    // Pas de nombre → poser la question et mémoriser la phase
    await savePhase(chatId, "awaiting_count");
    await send(chatId, "Combien de matchs voulez-vous analyser ? (1-10, défaut : 5)");
    return;
  }

  // ── Texte libre sans intention reconnue ─────────────
  await send(chatId,
    "Envoyez <b>/pronos</b> pour des pronostics, ou <b>/help</b> pour voir toutes les commandes."
  );
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot ⚽ — Pipeline Pronostics Sportifs IA v3");

  if (WEBHOOK_SECRET) {
    const sig = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (sig !== WEBHOOK_SECRET)
      return new Response("Unauthorized", { status: 401 });
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
