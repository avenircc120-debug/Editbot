// ═══════════════════════════════════════════════════════
//  FOOTBOT v5 — ESPN API + IA Groq + Prédictions complètes
//  ESPN (lastFiveGames + H2H + Odds) → Groq → Meilleur marché
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG       = `https://api.telegram.org/bot${TG_TOKEN}`;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_HDR  = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

// Maintient "en train d'écrire" pendant toute une opération longue
async function keepTyping(chatId: number, durationMs: number): Promise<void> {
  let elapsed = 0;
  while (elapsed < durationMs) {
    await typing(chatId);
    await sleep(4000);
    elapsed += 4000;
  }
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 1 — SCRAPING ESPN
// ══════════════════════════════════════════════════════

interface TeamStats {
  form5       : string;  // "V-N-D-V-V"
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
  totalMatches: number;
  homeWins    : number;
  awayWins    : number;
  draws       : number;
  homeWinPct  : number;
  awayWinPct  : number;
  drawPct     : number;
  avgGoals    : number;
  over25H2H   : number;
  bttsH2H     : number;
  lines       : string;
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
  overUnder: number;   // from ESPN odds (ex: 2.5)
  homeML   : number;   // moneyline home (American odds)
  awayML   : number;
}

// ── Extraction form ESPN lastFiveGames ──────────────
function extractFormESPN(events: any[], teamId: string): TeamStats {
  const last5 = (events ?? []).slice(0, 5);
  let wins5 = 0, draws5 = 0, losses5 = 0;
  let scored5 = 0, conceded5 = 0;
  let over25Count = 0, bttsCount = 0, cleanSheets = 0, failedScore = 0;
  const formArr: string[] = [];

  for (const ev of last5) {
    const isHome    = ev.homeTeamId === teamId;
    const myScore   = parseInt(isHome ? ev.homeTeamScore : ev.awayTeamScore, 10) || 0;
    const opScore   = parseInt(isHome ? ev.awayTeamScore : ev.homeTeamScore, 10) || 0;
    const total     = myScore + opScore;

    scored5   += myScore;
    conceded5 += opScore;
    if (total > 2.5)             over25Count++;
    if (myScore > 0 && opScore > 0) bttsCount++;
    if (opScore === 0)           cleanSheets++;
    if (myScore === 0)           failedScore++;

    const res = ev.gameResult?.toUpperCase();
    if      (res === "W") { wins5++;   formArr.push("V"); }
    else if (res === "L") { losses5++; formArr.push("D"); }
    else                  { draws5++;  formArr.push("N"); }
  }

  const n = last5.length || 1;
  return {
    form5      : formArr.join("-") || "N/A",
    wins5, draws5, losses5,
    scored5, conceded5,
    avgScored  : parseFloat((scored5   / n).toFixed(2)),
    avgConceded: parseFloat((conceded5 / n).toFixed(2)),
    over25Count, bttsCount, cleanSheets, failedScore,
  };
}

// ── Extraction H2H ESPN headToHeadGames ─────────────
function extractH2HESPN(teamsH2H: any[], homeTeamId: string): H2HStats {
  const empty: H2HStats = {
    totalMatches: 0, homeWins: 0, awayWins: 0, draws: 0,
    homeWinPct: 33, awayWinPct: 33, drawPct: 34,
    avgGoals: 2.5, over25H2H: 0, bttsH2H: 0, lines: "",
  };
  // Trouver les events du point de vue de l'équipe domicile
  const homeTeamData = teamsH2H?.find((t: any) => t.team?.id === homeTeamId);
  const events: any[] = homeTeamData?.events ?? teamsH2H?.[0]?.events ?? [];
  if (!events.length) return empty;

  let hw = 0, aw = 0, d = 0, totalGoals = 0, over25 = 0, btts = 0;
  const lines: string[] = [];

  for (const ev of events.slice(0, 8)) {
    const hs  = parseInt(ev.homeTeamScore, 10) || 0;
    const as_ = parseInt(ev.awayTeamScore, 10) || 0;
    const tot = hs + as_;
    totalGoals += tot;
    if (tot > 2.5)    over25++;
    if (hs > 0 && as_ > 0) btts++;

    // Du point de vue de l'équipe domicile actuelle
    const isHomeViewpoint = ev.homeTeamId === homeTeamId;
    const res = ev.gameResult?.toUpperCase();
    if      (res === "W") { isHomeViewpoint ? hw++ : aw++; }
    else if (res === "L") { isHomeViewpoint ? aw++ : hw++; }
    else                  { d++; }

    lines.push(`${hs}-${as_} (${ev.competitionName?.slice(0, 20) ?? "?"})`);
  }

  const total = hw + aw + d || 1;
  return {
    totalMatches: events.length,
    homeWins : hw, awayWins : aw, draws : d,
    homeWinPct : Math.round((hw / total) * 100),
    awayWinPct : Math.round((aw / total) * 100),
    drawPct    : Math.round((d  / total) * 100),
    avgGoals   : parseFloat((totalGoals / events.length).toFixed(2)),
    over25H2H  : over25,
    bttsH2H    : btts,
    lines      : lines.slice(0, 5).join(" | "),
  };
}

// ── Scraping complet d'un match via ESPN summary ─────
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

    // Summary ESPN : lastFiveGames + H2H + odds
    const summary = await espnFetch(`${ESPN_BASE}/all/summary?event=${event.id}`);
    if (!summary) return null;

    await sleep(300); // Évite le rate limit

    const lastFive: any[] = summary.lastFiveGames ?? [];
    const h2hData : any[] = summary.headToHeadGames ?? [];
    const oddsArr : any[] = summary.pickcenter ?? summary.odds ?? [];

    // Form des deux équipes
    const homeFormData = lastFive.find((t: any) => t.team?.id === homeId);
    const awayFormData = lastFive.find((t: any) => t.team?.id === awayId);

    const homeStats = extractFormESPN(homeFormData?.events ?? [], homeId);
    const awayStats = extractFormESPN(awayFormData?.events ?? [], awayId);

    // Minimum de données requis
    if (homeStats.wins5 + homeStats.draws5 + homeStats.losses5 < 1 &&
        awayStats.wins5 + awayStats.draws5 + awayStats.losses5 < 1) {
      console.log(`[SKIP] Pas de form pour ${homeTeam} vs ${awayTeam}`);
      return null;
    }

    const h2h = extractH2HESPN(h2hData, homeId);

    // Cotes ESPN (DraftKings ou premier provider)
    const odds = oddsArr[0];
    const overUnder = odds?.overUnder ?? 2.5;
    const homeML    = odds?.homeTeamOdds?.moneyLine ?? 0;
    const awayML    = odds?.awayTeamOdds?.moneyLine ?? 0;

    return { id: event.id, homeTeam, awayTeam, homeId, awayId, league, kickoff, homeStats, awayStats, h2h, overUnder, homeML, awayML };
  } catch (e) {
    console.error("[SCRAPE ERROR]", e);
    return null;
  }
}

// ── Liste des matchs du jour (ESPN) ─────────────────
async function scrapeUpcomingMatches(
  count: number,
  onProgress: (msg: string) => Promise<void>
): Promise<MatchData[]> {
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

// ══════════════════════════════════════════════════════
//  ÉTAPE 2 — SIGNAUX STATISTIQUES + ANALYSE IA
// ══════════════════════════════════════════════════════

interface Pronostic {
  index     : number;
  homeTeam  : string;
  awayTeam  : string;
  market    : string;
  choice    : string;
  confidence: number;
  reason    : string;
}

function computeSignals(m: MatchData): Record<string, number> {
  const h = m.homeStats;
  const a = m.awayStats;
  const x = m.h2h;

  const homeDom = (h.wins5 * 3 + h.draws5) / Math.max((h.wins5 + h.draws5 + h.losses5) * 3, 1);
  const awayDom = (a.wins5 * 3 + a.draws5) / Math.max((a.wins5 + a.draws5 + a.losses5) * 3, 1);

  // Conversion moneyline américain → probabilité implicite
  let homeProb = 33, awayProb = 33;
  if (m.homeML > 0) homeProb = Math.round(100 / (m.homeML / 100 + 1));
  else if (m.homeML < 0) homeProb = Math.round(Math.abs(m.homeML) / (Math.abs(m.homeML) + 100) * 100);
  if (m.awayML > 0) awayProb = Math.round(100 / (m.awayML / 100 + 1));
  else if (m.awayML < 0) awayProb = Math.round(Math.abs(m.awayML) / (Math.abs(m.awayML) + 100) * 100);

  const homeWin = Math.round(homeDom * 50 + (x.homeWinPct / 100) * 25 + (homeProb / 100) * 25);
  const awayWin = Math.round(awayDom * 50 + (x.awayWinPct / 100) * 25 + (awayProb / 100) * 25);
  const draw    = Math.round(x.drawPct * 0.6 + 15);

  const over25total = (h.over25Count + a.over25Count) / Math.max((h.wins5 + h.draws5 + h.losses5 + a.wins5 + a.draws5 + a.losses5), 1);
  const overOULine  = m.overUnder <= 2.0 ? 10 : m.overUnder >= 3.0 ? -10 : 0; // bonus si OU bas
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
    `DOM: forme=${h.form5} V${h.wins5}N${h.draws5}D${h.losses5} +${h.avgScored}/-${h.avgConceded} Over25:${h.over25Count} BTTS:${h.bttsCount} CS:${h.cleanSheets}`,
    `EXT: forme=${a.form5} V${a.wins5}N${a.draws5}D${a.losses5} +${a.avgScored}/-${a.avgConceded} Over25:${a.over25Count} BTTS:${a.bttsCount} CS:${a.cleanSheets}`,
    `H2H(${x.totalMatches}): DOM${x.homeWinPct}% NUL${x.drawPct}% EXT${x.awayWinPct}% moyButs:${x.avgGoals} Over25:${x.over25H2H} BTTS:${x.bttsH2H}`,
    `COTES ESPN: OU=${m.overUnder} DOM_ML=${m.homeML} EXT_ML=${m.awayML}`,
    `SIGNAUX: dom=${sig.homeWin}% nul=${sig.draw}% ext=${sig.awayWin}% over25=${sig.over25}% under25=${sig.under25}% btts=${sig.btts}% noBTTS=${sig.noBtts}%`,
  ].join("\n");
}

// Fallback local si Groq échoue — choix du meilleur signal
function localFallback(m: MatchData, index: number): Pronostic {
  const sig = computeSignals(m);
  const opts = [
    { market: "1X2",              choice: `Victoire ${m.homeTeam}`,    score: sig.homeWin, reason: `${m.homeStats.wins5}V sur 5, domination à domicile` },
    { market: "1X2",              choice: `Victoire ${m.awayTeam}`,    score: sig.awayWin, reason: `${m.awayStats.wins5}V sur 5, forme extérieure solide` },
    { market: "1X2",              choice: "Match nul",                  score: sig.draw,    reason: `H2H nul ${m.h2h.drawPct}%, équipes équilibrées` },
    { market: "Plus/Moins buts",  choice: `Plus de ${m.overUnder} buts`,score: sig.over25, reason: `Over25 fréquent (${m.homeStats.over25Count + m.awayStats.over25Count}/10)` },
    { market: "Plus/Moins buts",  choice: `Moins de ${m.overUnder} buts`,score:sig.under25,reason: `Défenses solides (${m.homeStats.cleanSheets + m.awayStats.cleanSheets} CS/10)` },
    { market: "BTTS",             choice: "Les deux marquent",          score: sig.btts,    reason: `BTTS fréquent (${m.homeStats.bttsCount + m.awayStats.bttsCount}/10)` },
    { market: "BTTS",             choice: "BTTS Non",                   score: sig.noBtts,  reason: `Défenses hermétiques récemment` },
  ];
  opts.sort((a, b) => b.score - a.score);
  const best = opts[0];
  return { index, homeTeam: m.homeTeam, awayTeam: m.awayTeam, market: best.market, choice: best.choice, confidence: Math.min(Math.max(best.score, 55), 88), reason: best.reason };
}

async function analyseWithAI(matches: MatchData[]): Promise<Pronostic[]> {
  if (!matches.length) return [];

  const allStats = matches.map((m, i) => `=== MATCH ${i + 1} ===\n${buildStatsBlock(m)}`).join("\n\n");

  const prompt = `Tu es expert en statistiques de paris sportifs. Pour chaque match, choisis LE marché avec la probabilité réelle la plus forte parmi : 1X2, BTTS Oui/Non, Plus/Moins buts (utilise la valeur OU fournie), Double chance.

RÈGLES :
- Analyse les signaux calculés ET les stats brutes ET les cotes ESPN.
- Signal >65% = fort indicateur. Cotes ESPN confirment ou infirment.
- Confiance entre 55% et 88%.
- Raison : 1 phrase courte et factuelle basée sur les chiffres.
- RÉPONDS UNIQUEMENT en JSON valide, rien d'autre :
[{"index":1,"homeTeam":"X","awayTeam":"Y","market":"Marché","choice":"Choix précis","confidence":72,"reason":"Raison stats"}]`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 28_000);
    const r     = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method : "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      signal : ctrl.signal,
      body   : JSON.stringify({
        model      : "llama-3.1-8b-instant",
        temperature: 0.1,
        max_tokens : Math.min(220 * matches.length, 1400),
        messages   : [
          { role: "system", content: prompt },
          { role: "user",   content: allStats },
        ],
      }),
    });
    clearTimeout(timer);

    const json = await r.json();
    if (json.error) { console.error("Groq:", json.error.message); return matches.map((m, i) => localFallback(m, i + 1)); }

    const raw    = json.choices?.[0]?.message?.content ?? "";
    const parsed = raw.match(/\[[\s\S]*\]/);
    if (!parsed) { console.error("Groq: JSON absent:", raw.slice(0, 150)); return matches.map((m, i) => localFallback(m, i + 1)); }

    try { return JSON.parse(parsed[0]) as Pronostic[]; }
    catch { return matches.map((m, i) => localFallback(m, i + 1)); }
  } catch (e: any) {
    console.error("Groq error:", e?.message);
    return matches.map((m, i) => localFallback(m, i + 1));
  }
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 3 — FORMAT DE SORTIE
// ══════════════════════════════════════════════════════
function barConfidence(pct: number): string {
  const filled = Math.round(pct / 10);
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled) + ` ${pct}%`;
}

function formatPronostics(pros: Pronostic[]): string {
  if (!pros.length) return "Aucun pronostic disponible.";
  return pros.map((p, i) =>
    `${i + 1}. ⚽ <b>${p.homeTeam} vs ${p.awayTeam}</b>\n` +
    `👉 <b>${p.market}</b> → <b>${p.choice}</b>\n` +
    `${barConfidence(p.confidence)}\n` +
    `📊 <i>${p.reason}</i>`
  ).join("\n\n");
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════
async function runPipeline(chatId: number, count: number): Promise<void> {
  // Typing immédiat pour montrer que le bot travaille
  await typing(chatId);
  await send(chatId,
    `🤖 Analyse de <b>${count} match${count > 1 ? "s" : ""}</b> en cours...\n` +
    `📡 Connexion aux données ESPN en temps réel`
  );

  // Lance le typing en fond + scraping
  let scrapeDone = false;
  (async () => { while (!scrapeDone) { await typing(chatId); await sleep(4000); } })();

  const onProgress = async (msg: string) => { await typing(chatId); await send(chatId, msg); };

  const matches = await scrapeUpcomingMatches(count, onProgress);
  scrapeDone    = true;

  if (!matches.length) {
    await typing(chatId);
    await send(chatId,
      "😔 Aucun match disponible pour l'instant.\n\n" +
      "Il n'y a peut-être pas de matchs programmés aujourd'hui, " +
      "ou les données ne sont pas encore disponibles. Réessaie dans quelques heures !"
    );
    return;
  }

  await typing(chatId);
  await send(chatId,
    `✅ <b>${matches.length} match${matches.length > 1 ? "s" : ""} trouvé${matches.length > 1 ? "s" : ""}</b>\n` +
    `🧠 L'IA analyse toutes les statistiques...`
  );

  // Typing pendant l'IA
  let aiDone = false;
  (async () => { while (!aiDone) { await typing(chatId); await sleep(4000); } })();

  const pronostics = await analyseWithAI(matches);
  aiDone           = true;

  const date   = new Date().toLocaleDateString("fr-FR");
  const header = `⚽ <b>Pronostics IA — ${date}</b>\n` +
                 `<i>Basés sur forme récente · H2H · Cotes ESPN</i>\n\n`;

  await send(chatId, header + formatPronostics(pronostics));
}

// ══════════════════════════════════════════════════════
//  COMMANDES BONUS
// ══════════════════════════════════════════════════════
async function cmdLive(chatId: number): Promise<void> {
  await typing(chatId);
  const data   = await espnFetch(`${ESPN_BASE}/all/scoreboard`);
  const events = (data?.events ?? []).filter((e: any) => e.competitions?.[0]?.status?.type?.state === "in");
  if (!events.length) { await send(chatId, "⚽ Aucun match en direct pour l'instant."); return; }
  const lines = events.slice(0, 10).map((e: any) => {
    const comp = e.competitions?.[0];
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
    const min  = comp?.status?.displayClock ?? "";
    return `🔴 ${home?.team?.displayName} <b>${home?.score}</b>-<b>${away?.score}</b> ${away?.team?.displayName} ${min ? `(${min})` : ""}`;
  });
  await send(chatId, `🔴 <b>Matchs en direct</b>\n\n${lines.join("\n")}`);
}

async function cmdToday(chatId: number): Promise<void> {
  await typing(chatId);
  const data   = await espnFetch(`${ESPN_BASE}/all/scoreboard?dates=${todayESPN()}`);
  const events = (data?.events ?? []).filter((e: any) => e.competitions?.[0]?.status?.type?.state === "pre");
  if (!events.length) { await send(chatId, "Aucun match de football prévu aujourd'hui."); return; }
  const lines = events.slice(0, 15).map((e: any) => {
    const comp = e.competitions?.[0];
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home")?.team?.displayName ?? "?";
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away")?.team?.displayName ?? "?";
    const time = comp?.startDate ? fmtTime(comp.startDate) : "?";
    return `${time} — ${home} vs ${away}`;
  });
  await send(chatId, `📅 <b>${events.length} match${events.length > 1 ? "s" : ""} aujourd'hui</b>\n\n${lines.join("\n")}`);
}

async function cmdHelp(chatId: number): Promise<void> {
  await send(chatId,
    `⚽ <b>FootBot IA</b>\n\n` +
    `Dis-moi simplement combien de matchs tu veux analyser — ex: <b>"5"</b> ou <b>"donne-moi 3 pronos"</b>\n\n` +
    `Autres options :\n` +
    `• <b>live</b> — matchs en cours\n` +
    `• <b>programme</b> — matchs du jour\n` +
    `• <b>/pronos N</b> — N pronostics directs`
  );
}

// ══════════════════════════════════════════════════════
//  ROUTEUR CONVERSATIONNEL
// ══════════════════════════════════════════════════════

const GREETING = /^(salut|slt|cc|coucou|bonjour|bonsoir|bonnenuit|yo|hey|cava|cavabien|quoideneuf|hi|hello|howdy|sup|whatsup|goodmorning|goodevening|goodnight|hiya|greetings|salam|slam|salamaleykoum|waaleykoum|sabahalkheir|msalkhir|labas|wach|wsh|hola|buenas|buenosdias|ciao|salve|buongiorno|buonasera|ola|oi|hallo|servus|moin|merhaba|selam|privet|zdravo|allo|nsm|nss|bb|frero|frr|frere|wesh|wech|saga|sag|ey)[\s!?.🙂👋😊]*$/i;

const PRONOS_INTENT = /pronos|pronostic|predict|paris|mise|bet|cote|analyse|tip|match|foot|football|pari|jeu|jouer/i;

const LIVE_INTENT    = /live|direct|en cours|score|résultat|result/i;
const PROGRAM_INTENT = /programme|aujourd|auj|calendrier|planning|matchs du jour/i;

const WORD_NUM: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

const GREET_REPLIES = [
  "Wesh ! 👋 Je suis FootBot, ton assistant pronostics IA.\nCombien de matchs tu veux que j'analyse aujourd'hui ? (ex: 3, 5, 10)",
  "Salut ! ⚽ Prêt à analyser les stats en temps réel.\nDis-moi combien de matchs tu veux — je m'occupe du reste.",
  "Hey ! 🤖 Je scrappe les données ESPN et analyse chaque match.\nCombien tu en veux ? (1 à 10)",
  "Salam ! ⚽ Combien de matchs je t'analyse aujourd'hui ?",
  "Bonjour ! Je suis ton bot football IA. Dis-moi combien de matchs tu veux analyser.",
];

function extractNumber(text: string): number | null {
  const m = text.match(/\b(\d{1,2})\b/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 10) return n; }
  const w = WORD_NUM[text.trim().toLowerCase()];
  return w ?? null;
}

async function handle(chatId: number, text: string): Promise<void> {
  const raw   = text.trim();
  const lower = raw.toLowerCase();

  // ── Commandes slash directes ─────────────────────────
  const pronosCmd = lower.match(/^\/pronos(?:tics?)?\s*(\d+)?/);
  if (pronosCmd) {
    const n = Math.min(Math.max(parseInt(pronosCmd[1] ?? "5", 10), 1), 10);
    await savePhase(chatId, "idle");
    await runPipeline(chatId, n);
    return;
  }
  if (/^\/live$/.test(lower))              { await cmdLive(chatId);   return; }
  if (/^\/auj$|^\/today$/.test(lower))     { await cmdToday(chatId);  return; }
  if (/^\/start$|^\/help$/.test(lower))    { await cmdHelp(chatId);   return; }

  // ── Intentions naturelles sans slash ────────────────
  if (LIVE_INTENT.test(lower))    { await cmdLive(chatId);  return; }
  if (PROGRAM_INTENT.test(lower)) { await cmdToday(chatId); return; }

  // ── Phase en cours : on attend un nombre ────────────
  const phase = await loadPhase(chatId);

  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPipeline(chatId, num);
      return;
    }
    if (/^(oui|ok|yes|go|vas-?y|allez|top|super|parfait|let'?s?\s?go|yep|yup|bien\s?sûr|bah\s?oui|ouais)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await runPipeline(chatId, 5);
      return;
    }
    if (/^(non|no|annule|stop|cancel|rien|nope|nan)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await send(chatId, "Pas de souci 👌 Reviens quand tu veux des pronostics !");
      return;
    }
    if (GREETING.test(raw)) {
      await send(chatId, "😄 Donne-moi un chiffre entre 1 et 10 pour lancer l'analyse !");
      return;
    }
    await send(chatId, "Donne-moi un chiffre entre 1 et 10 👇");
    return;
  }

  // ── Salutation ──────────────────────────────────────
  if (GREETING.test(raw)) {
    await savePhase(chatId, "awaiting_count");
    await send(chatId, GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)]);
    return;
  }

  // ── Intention pronostic avec nombre inclus ───────────
  if (PRONOS_INTENT.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPipeline(chatId, num);
      return;
    }
    await savePhase(chatId, "awaiting_count");
    await send(chatId, "⚽ Combien de matchs tu veux analyser ? (1 à 10)");
    return;
  }

  // ── Message court sans ponctuation = probable salut ─
  if (raw.length <= 20 && !/[/\\@#]/.test(raw) && !raw.includes(" ")) {
    const num = extractNumber(raw);
    if (num !== null) {
      // Chiffre seul → lancer si on était en attente, sinon demander
      if (phase === "awaiting_count") {
        await savePhase(chatId, "idle");
        await runPipeline(chatId, num);
        return;
      }
    }
    await savePhase(chatId, "awaiting_count");
    await send(chatId, GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)]);
    return;
  }

  // ── Fallback naturel ─────────────────────────────────
  await savePhase(chatId, "awaiting_count");
  await send(chatId, "⚽ Combien de matchs tu veux que j'analyse ? Donne-moi un chiffre entre <b>1 et 10</b>.");
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot v5 ⚽ ESPN + IA Groq");

  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
