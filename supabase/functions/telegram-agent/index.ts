// ═══════════════════════════════════════════════════════
//  FOOTBOT v4 — Scraping complet + Prédiction IA multi-marchés
//  SofaScore → Stats complètes → Groq 8b → Meilleur marché
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG       = `https://api.telegram.org/bot${TG_TOKEN}`;

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

// ── Utilitaires ───────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// sfFetch avec timeout 12s + retry 2x avec délai croissant
async function sfFetch(path: string, attempt = 0): Promise<any> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch(`https://api.sofascore.com/api/v1${path}`, {
      headers: SF,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (r.ok) return r.json();

    // Rate limit (429) ou erreur serveur → retry
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return sfFetch(path, attempt + 1);
    }
    return null;
  } catch (e: any) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return sfFetch(path, attempt + 1);
    }
    return null;
  }
}

const todayStr = () => new Date().toISOString().split("T")[0];

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit" });

// ══════════════════════════════════════════════════════
//  SESSION (phase conversationnelle)
// ══════════════════════════════════════════════════════

type Phase = "idle" | "awaiting_count";

function sbHeaders(): Record<string, string> {
  return {
    "apikey"       : SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type" : "application/json",
    "Prefer"       : "resolution=merge-duplicates,return=minimal",
  };
}

async function loadPhase(chatId: number): Promise<Phase> {
  if (!SB_URL || !SB_KEY) return "idle";
  try {
    const r = await fetch(`${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase`, { headers: sbHeaders() });
    if (!r.ok) return "idle";
    const rows: any[] = await r.json();
    return (rows?.[0]?.phase as Phase) ?? "idle";
  } catch { return "idle"; }
}

async function savePhase(chatId: number, phase: Phase): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method: "POST", headers: sbHeaders(),
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

// ══════════════════════════════════════════════════════
//  ÉTAPE 1 — SCRAPING COMPLET
// ══════════════════════════════════════════════════════

interface TeamStats {
  // Forme générale
  form5       : string;   // "V-V-N-D-V"
  wins5       : number;
  draws5      : number;
  losses5     : number;
  // Buts
  scored5     : number;   // total buts marqués sur 5 matchs
  conceded5   : number;   // total buts encaissés sur 5 matchs
  avgScored   : number;   // moyenne buts marqués
  avgConceded : number;   // moyenne buts encaissés
  // Marchés
  over25Count : number;   // nb matchs avec +2.5 buts sur 5
  bttsCount   : number;   // nb matchs BTTS sur 5
  cleanSheets : number;   // nb matchs sans encaisser sur 5
  failedScore : number;   // nb matchs sans marquer sur 5
  // Forme domicile/extérieur spécifique
  homeWins    : number;
  homeLosses  : number;
  awayWins    : number;
  awayLosses  : number;
}

interface H2HStats {
  lines       : string;
  totalMatches: number;
  homeWins    : number;   // victoires équipe domicile du match actuel
  awayWins    : number;
  draws       : number;
  homeWinPct  : number;
  awayWinPct  : number;
  drawPct     : number;
  avgGoals    : number;   // moyenne de buts dans les h2h
  over25H2H   : number;   // nb matchs h2h avec +2.5 buts
  bttsH2H     : number;   // nb matchs h2h BTTS
}

interface MatchData {
  id        : number;
  homeTeam  : string;
  awayTeam  : string;
  league    : string;
  kickoff   : string;
  homeStats : TeamStats;
  awayStats : TeamStats;
  h2h       : H2HStats;
  homeRank  ?: number;
  awayRank  ?: number;
}

// ── Extraction stats équipe ────────────────────────────
function extractTeamStats(events: any[], teamId: number, role: "home" | "away"): TeamStats {
  const last5 = (events ?? []).slice(-5);

  let wins5 = 0, draws5 = 0, losses5 = 0;
  let scored5 = 0, conceded5 = 0;
  let over25Count = 0, bttsCount = 0, cleanSheets = 0, failedScore = 0;
  let homeWins = 0, homeLosses = 0, awayWins = 0, awayLosses = 0;
  const formArr: string[] = [];

  for (const e of last5) {
    const isHome  = e.homeTeam?.id === teamId;
    const hs      = e.homeScore?.current ?? 0;
    const as_     = e.awayScore?.current ?? 0;
    const myScore = isHome ? hs : as_;
    const opScore = isHome ? as_ : hs;
    const total   = hs + as_;

    scored5   += myScore;
    conceded5 += opScore;

    if (total > 2.5) over25Count++;
    if (hs > 0 && as_ > 0) bttsCount++;
    if (opScore === 0) cleanSheets++;
    if (myScore === 0) failedScore++;

    if (myScore > opScore) {
      wins5++;
      formArr.push("V");
      if (isHome) homeWins++; else awayWins++;
    } else if (myScore < opScore) {
      losses5++;
      formArr.push("D");
      if (isHome) homeLosses++; else awayLosses++;
    } else {
      draws5++;
      formArr.push("N");
    }
  }

  const n = last5.length || 1;
  return {
    form5: formArr.join("-") || "N/A",
    wins5, draws5, losses5,
    scored5, conceded5,
    avgScored  : parseFloat((scored5   / n).toFixed(2)),
    avgConceded: parseFloat((conceded5 / n).toFixed(2)),
    over25Count, bttsCount, cleanSheets, failedScore,
    homeWins, homeLosses, awayWins, awayLosses,
  };
}

// ── Extraction H2H ────────────────────────────────────
function extractH2H(data: any, homeName: string, awayName: string): H2HStats {
  const empty: H2HStats = {
    lines: "Pas de h2h", totalMatches: 0,
    homeWins: 0, awayWins: 0, draws: 0,
    homeWinPct: 33, awayWinPct: 33, drawPct: 34,
    avgGoals: 2.5, over25H2H: 0, bttsH2H: 0,
  };
  if (!data) return empty;

  const events: any[] = [
    ...(data.previousEvents ?? []),
    ...(data.homeEvents ?? []),
    ...(data.awayEvents ?? []),
  ].slice(-8);

  if (!events.length) return empty;

  let hw = 0, aw = 0, d = 0, totalGoals = 0, over25 = 0, btts = 0;
  const lines: string[] = [];
  const homeLower = homeName.toLowerCase().slice(0, 5);

  for (const e of events) {
    const hn  = e.homeTeam?.name ?? "?";
    const an  = e.awayTeam?.name ?? "?";
    const hs  = e.homeScore?.current ?? 0;
    const as_ = e.awayScore?.current ?? 0;
    const tot = hs + as_;
    totalGoals += tot;
    if (tot > 2.5) over25++;
    if (hs > 0 && as_ > 0) btts++;
    lines.push(`${hn} ${hs}-${as_} ${an} (${fmtDate(e.startTimestamp)})`);
    const isHomeTheHome = hn.toLowerCase().includes(homeLower);
    if (hs > as_) { isHomeTheHome ? hw++ : aw++; }
    else if (hs < as_) { isHomeTheHome ? aw++ : hw++; }
    else { d++; }
  }

  const total = hw + aw + d || 1;
  return {
    lines      : lines.slice(-5).join(" | "),
    totalMatches: events.length,
    homeWins: hw, awayWins: aw, draws: d,
    homeWinPct : Math.round((hw / total) * 100),
    awayWinPct : Math.round((aw / total) * 100),
    drawPct    : Math.round((d  / total) * 100),
    avgGoals   : parseFloat((totalGoals / events.length).toFixed(2)),
    over25H2H  : over25,
    bttsH2H    : btts,
  };
}

// ── Scraping d'un match avec validation de données ────
async function scrapeMatchStats(event: any): Promise<MatchData | null> {
  try {
    const matchId  = event.id;
    const homeTeam = event.homeTeam?.name ?? "?";
    const awayTeam = event.awayTeam?.name ?? "?";
    const league   = event.tournament?.name ?? "?";
    const kickoff  = event.startTimestamp ? fmtTime(event.startTimestamp) : "?";
    const homeId   = event.homeTeam?.id;
    const awayId   = event.awayTeam?.id;

    if (!homeId || !awayId) return null;

    // Requêtes séquentielles pour éviter le rate limit SofaScore
    const homeEvts = await sfFetch(`/team/${homeId}/events/last/0`);
    await sleep(400);
    const awayEvts = await sfFetch(`/team/${awayId}/events/last/0`);
    await sleep(400);
    const h2hData  = await sfFetch(`/event/${matchId}/h2h/events`);

    const homeEvents: any[] = homeEvts?.events ?? [];
    const awayEvents: any[] = awayEvts?.events ?? [];

    // Validation : on exige au moins 2 matchs réels pour chaque équipe
    if (homeEvents.length < 2 && awayEvents.length < 2) {
      console.log(`[SKIP] Pas assez de données pour ${homeTeam} vs ${awayTeam}`);
      return null;
    }

    const homeStats = extractTeamStats(homeEvents, homeId, "home");
    const awayStats = extractTeamStats(awayEvents, awayId, "away");
    const h2h       = extractH2H(h2hData, homeTeam, awayTeam);

    return { id: matchId, homeTeam, awayTeam, league, kickoff, homeStats, awayStats, h2h };
  } catch (e) {
    console.error(`[SCRAPE ERROR]`, e);
    return null;
  }
}

// ── Scraping des matchs du jour (séquentiel + délai) ──
async function scrapeUpcomingMatches(count: number, onProgress: (msg: string) => void): Promise<MatchData[]> {
  const data = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
  const candidates: any[] = (data?.events ?? [])
    .filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id) && e.status?.type === "notstarted");

  if (!candidates.length) return [];

  const results: MatchData[] = [];
  let tried = 0;

  for (const event of candidates) {
    if (results.length >= count) break;
    tried++;

    const name = `${event.homeTeam?.name ?? "?"} vs ${event.awayTeam?.name ?? "?"}`;
    onProgress(`🔍 Analyse ${results.length + 1}/${count} — ${name}...`);

    const match = await scrapeMatchStats(event);
    if (match) results.push(match);

    // Pause entre chaque match pour ne pas se faire bloquer
    if (tried < candidates.length && results.length < count) {
      await sleep(600);
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 2 — ANALYSE IA : toutes les stats → meilleur marché
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

// Calcul local des signaux statistiques pour aider l'IA
function computeSignals(m: MatchData): Record<string, number> {
  const h = m.homeStats;
  const a = m.awayStats;
  const x = m.h2h;

  // Signal 1X2
  const homeDominance = (h.wins5 * 3 + h.draws5) / 15;        // 0-1
  const awayDominance = (a.wins5 * 3 + a.draws5) / 15;
  const h2hHomePct    = x.homeWinPct / 100;

  // Signal Over 2.5
  const homeAttack   = Math.min(h.avgScored / 2, 1);
  const awayAttack   = Math.min(a.avgScored / 2, 1);
  const over25Rate   = ((h.over25Count + a.over25Count) / 10 + x.over25H2H / x.totalMatches || 0) / 2;

  // Signal BTTS
  const homeScoringRate  = 1 - h.failedScore / 5;
  const awayScoringRate  = 1 - a.failedScore / 5;
  const homeConcedesRate = 1 - h.cleanSheets / 5;
  const awayConcedesRate = 1 - a.cleanSheets / 5;
  const bttsRate = (homeScoringRate * awayConcedesRate + awayScoringRate * homeConcedesRate) / 2;
  const h2hBttsRate = x.bttsH2H / (x.totalMatches || 1);

  // Signal Under 2.5
  const underRate = 1 - over25Rate;

  return {
    homeWin   : Math.round(((homeDominance * 0.6 + h2hHomePct * 0.4)) * 100),
    awayWin   : Math.round(((awayDominance * 0.6 + (x.awayWinPct / 100) * 0.4)) * 100),
    draw      : Math.round(x.drawPct),
    over25    : Math.round(((over25Rate * 0.7 + (homeAttack + awayAttack) / 2 * 0.3)) * 100),
    under25   : Math.round((underRate * 0.8) * 100),
    btts      : Math.round(((bttsRate * 0.6 + h2hBttsRate * 0.4)) * 100),
    noBtts    : Math.round(((1 - bttsRate) * 0.6 + (1 - h2hBttsRate) * 0.4) * 100),
  };
}

function buildCompactStats(m: MatchData): string {
  const h = m.homeStats;
  const a = m.awayStats;
  const x = m.h2h;
  const sig = computeSignals(m);

  return [
    `${m.homeTeam} vs ${m.awayTeam} [${m.league}]`,
    `DOM forme:${h.form5} V${h.wins5}N${h.draws5}D${h.losses5} buts:+${h.avgScored}/-${h.avgConceded} Over25:${h.over25Count}/5 BTTS:${h.bttsCount}/5 CS:${h.cleanSheets}/5`,
    `EXT forme:${a.form5} V${a.wins5}N${a.draws5}D${a.losses5} buts:+${a.avgScored}/-${a.avgConceded} Over25:${a.over25Count}/5 BTTS:${a.bttsCount}/5 CS:${a.cleanSheets}/5`,
    `H2H(${x.totalMatches}): DOM${x.homeWinPct}% NUL${x.drawPct}% EXT${x.awayWinPct}% moyButs:${x.avgGoals} Over25:${x.over25H2H}/${x.totalMatches} BTTS:${x.bttsH2H}/${x.totalMatches}`,
    `SIGNAUX: 1dom:${sig.homeWin}% nul:${sig.draw}% 1ext:${sig.awayWin}% over25:${sig.over25}% under25:${sig.under25}% btts:${sig.btts}% noBTTS:${sig.noBtts}%`,
  ].join("\n");
}

async function analyseWithAI(matches: MatchData[]): Promise<Pronostic[]> {
  if (!matches.length) return [];

  const allStats = matches.map((m, i) => `=== MATCH ${i + 1} ===\n${buildCompactStats(m)}`).join("\n\n");

  const systemPrompt = `Tu es un expert en analyse statistique de paris sportifs.
Pour chaque match, analyse toutes les statistiques fournies (forme, buts, H2H, signaux calculés) et choisis le marché avec la probabilité réelle la plus forte parmi :
- Victoire domicile / Nul / Victoire extérieur (1X2)
- Les deux équipes marquent Oui/Non (BTTS)
- Plus de 2.5 buts / Moins de 2.5 buts
- Double chance (1X, X2, 12)

RÈGLES :
- Appuie-toi sur les signaux calculés ET sur les stats brutes.
- Si un signal dépasse 65%, c'est un fort indicateur.
- Confiance entre 55% et 90%.
- Raison : 1 phrase courte basée sur les stats.
- Réponds UNIQUEMENT en JSON valide :
[{"index":1,"homeTeam":"X","awayTeam":"Y","market":"Marché","choice":"Choix","confidence":75,"reason":"Raison courte"}]`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method : "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      signal : ctrl.signal,
      body   : JSON.stringify({
        model      : "llama-3.1-8b-instant",
        temperature: 0.15,
        max_tokens : Math.min(200 * matches.length, 1200), // plus de place pour raisonner
        messages   : [
          { role: "system", content: systemPrompt },
          { role: "user",   content: allStats },
        ],
      }),
    });
    clearTimeout(timer);

    const json = await r.json();
    if (json.error) {
      console.error("Groq error:", json.error.message);
      return matches.map((m, i) => localFallback(m, i + 1));
    }
    const raw    = json.choices?.[0]?.message?.content ?? "[]";
    const parsed = raw.match(/\[[\s\S]*\]/);
    if (!parsed) {
      console.error("Groq: JSON introuvable dans la réponse:", raw.slice(0, 200));
      return matches.map((m, i) => localFallback(m, i + 1));
    }
    try {
      return JSON.parse(parsed[0]) as Pronostic[];
    } catch {
      console.error("Groq: JSON malformé:", parsed[0].slice(0, 200));
      return matches.map((m, i) => localFallback(m, i + 1));
    }
  } catch (e: any) {
    console.error("Groq fetch error:", e?.message);
    return matches.map((m, i) => localFallback(m, i + 1));
  }
}

// Fallback local si Groq indisponible — basé sur les signaux calculés
function localFallback(m: MatchData, index: number): Pronostic {
  const sig = computeSignals(m);
  const markets: { market: string; choice: string; score: number; reason: string }[] = [
    { market: "1X2", choice: `Victoire ${m.homeTeam}`, score: sig.homeWin, reason: `Domination domicile (${m.homeStats.wins5}/5 victoires)` },
    { market: "1X2", choice: `Victoire ${m.awayTeam}`, score: sig.awayWin, reason: `Domination extérieur (${m.awayStats.wins5}/5 victoires)` },
    { market: "1X2", choice: "Match nul", score: sig.draw, reason: `Tendance nul (H2H ${m.h2h.drawPct}%)` },
    { market: "Plus/Moins 2.5 buts", choice: "Plus de 2.5 buts", score: sig.over25, reason: `Moy. buts élevée (${m.homeStats.avgScored + m.awayStats.avgScored} buts/match)` },
    { market: "Plus/Moins 2.5 buts", choice: "Moins de 2.5 buts", score: sig.under25, reason: `Défenses solides (CS: ${m.homeStats.cleanSheets + m.awayStats.cleanSheets}/10)` },
    { market: "BTTS", choice: "Les deux marquent", score: sig.btts, reason: `Attaques actives (BTTS: ${m.homeStats.bttsCount + m.awayStats.bttsCount}/10)` },
    { market: "BTTS", choice: "BTTS Non", score: sig.noBtts, reason: `Défenses solides (CS: ${m.homeStats.cleanSheets + m.awayStats.cleanSheets}/10)` },
  ];
  markets.sort((a, b) => b.score - a.score);
  const best = markets[0];
  return {
    index,
    homeTeam  : m.homeTeam,
    awayTeam  : m.awayTeam,
    market    : best.market,
    choice    : best.choice,
    confidence: Math.min(Math.max(best.score, 55), 90),
    reason    : best.reason,
  };
}

// ══════════════════════════════════════════════════════
//  ÉTAPE 3 — FORMAT DE SORTIE
// ══════════════════════════════════════════════════════

function formatPronostics(pronostics: Pronostic[]): string {
  if (!pronostics.length)
    return "❌ Aucun match disponible dans les grandes ligues pour l'instant.";
  return pronostics.map((p, i) =>
    `${i + 1}. <b>${p.homeTeam} vs ${p.awayTeam}</b>\n` +
    `👉 Marché : ${p.market} | Choix : ${p.choice} | Confiance : ${p.confidence}%\n` +
    `📊 ${p.reason}`
  ).join("\n\n");
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRINCIPAL
// ══════════════════════════════════════════════════════

async function runPronosticPipeline(chatId: number, count: number): Promise<void> {
  await send(chatId,
    `🤖 <b>FootBot démarre l'analyse...</b>\n\n` +
    `📡 Connexion SofaScore en cours...\n` +
    `Je vais collecter toutes les stats réelles pour ${count} match${count > 1 ? "s" : ""} d'aujourd'hui.`
  );

  // Callback de progression — envoie une mise à jour à chaque match scrapé
  const seenProgress = new Set<string>();
  const onProgress = async (msg: string) => {
    if (!seenProgress.has(msg)) {
      seenProgress.add(msg);
      await send(chatId, msg).catch(() => {});
    }
  };

  const matches = await scrapeUpcomingMatches(count, onProgress);

  if (!matches.length) {
    await send(chatId,
      "❌ Pas de matchs disponibles dans les grandes ligues aujourd'hui.\n" +
      "Réessaie plus tard ou utilise /auj pour voir le programme."
    );
    return;
  }

  // Résumé du scraping
  await send(chatId,
    `✅ <b>${matches.length} match${matches.length > 1 ? "s" : ""} scrapé${matches.length > 1 ? "s" : ""} avec succès !</b>\n\n` +
    `🧠 <i>Analyse IA en cours... L'IA examine chaque statistique pour trouver le meilleur marché.</i>`
  );

  const pronostics = await analyseWithAI(matches);

  const isAIResult = pronostics.some(p => p.reason && p.reason.length > 10);
  const header = isAIResult
    ? `⚽ <b>Pronostics IA — ${new Date().toLocaleDateString("fr-FR")}</b>\n<i>Basés sur forme, buts, H2H et signaux statistiques</i>\n\n`
    : `⚽ <b>Pronostics — ${new Date().toLocaleDateString("fr-FR")}</b>\n<i>Basés sur les statistiques calculées localement</i>\n\n`;

  await send(chatId, header + formatPronostics(pronostics));
}

// ══════════════════════════════════════════════════════
//  COMMANDES SIMPLES
// ══════════════════════════════════════════════════════

async function cmdLive(chatId: number): Promise<void> {
  const data   = await sfFetch(`/sport/football/events/live`);
  const events = (data?.events ?? []).filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id));
  if (!events.length) { await send(chatId, "Aucun match en direct dans les grandes ligues."); return; }
  const lines = events.slice(0, 10).map((e: any) =>
    `⚽ ${e.homeTeam?.name} ${e.homeScore?.current ?? 0}-${e.awayScore?.current ?? 0} ${e.awayTeam?.name} (${e.tournament?.name})`
  );
  await send(chatId, `🔴 <b>Matchs en direct</b>\n\n${lines.join("\n")}`);
}

async function cmdToday(chatId: number): Promise<void> {
  const data   = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
  const events = (data?.events ?? []).filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id));
  if (!events.length) { await send(chatId, "Aucun match prévu aujourd'hui dans les grandes ligues."); return; }
  const lines = events.slice(0, 15).map((e: any) =>
    `${fmtTime(e.startTimestamp)} — ${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`
  );
  await send(chatId, `📅 <b>Matchs du jour</b>\n\n${lines.join("\n")}`);
}

async function cmdStanding(chatId: number, leagueKey: string): Promise<void> {
  const lg = LEAGUES[leagueKey];
  if (!lg) { await send(chatId, `Ligue inconnue. Disponibles : ${Object.keys(LEAGUES).join(", ")}`); return; }
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
  const [, events] = await Promise.all([sfFetch(`/team/${team.id}`), sfFetch(`/team/${team.id}/events/last/0`)]);
  const stats = extractTeamStats(events?.events ?? [], team.id, "home");
  await send(chatId,
    `🏟 <b>${team.name}</b>\n` +
    `Forme : ${stats.form5} | ${stats.wins5}V ${stats.draws5}N ${stats.losses5}D\n` +
    `Buts : +${stats.avgScored}/-${stats.avgConceded} par match\n` +
    `Over 2.5 : ${stats.over25Count}/5 | BTTS : ${stats.bttsCount}/5 | CS : ${stats.cleanSheets}/5`
  );
}

async function cmdHelp(chatId: number): Promise<void> {
  await send(chatId,
    `⚽ <b>FootBot</b> — Je suis ton assistant pronostics IA !\n\n` +
    `Dis-moi juste combien de matchs tu veux analyser, ou utilise :\n\n` +
    `/live — Matchs en direct\n` +
    `/auj — Matchs du jour\n` +
    `/classement [ligue] — Classement (premier, laliga, ligue1, bundesliga, seriea, ucl)\n` +
    `/equipe [nom] — Stats complètes d'une équipe`
  );
}

// ══════════════════════════════════════════════════════
//  ROUTEUR
// ══════════════════════════════════════════════════════

// Salutations dans toutes les langues + messages courts sans ponctuation
const GREETING = /^(salut|slt|cc|coucou|bonjour|bonsoir|bonnenuit|yo|hey|cava|cavabien|quoideneuf|hi|hello|howdy|sup|whatsup|goodmorning|goodevening|goodnight|hiya|greetings|salam|slam|salamaleykoum|waaleykoum|sabahalkheir|msalkhir|labas|wach|wsh|hola|buenas|buenosdias|ciao|salve|buongiorno|buonasera|ola|oi|bonjour|hallo|servus|moin|merhaba|selam|privet|zdravo|allo|nsm|nss|bb|frero|frr|frere|wesh|wech|saga|sag|hey|yo|ey)[\s!?.🙂👋😊]*$/i;

const PRONOS_INTENT = /pronos|pronostic|predict|paris|mise|bet|côte|cote|analyse|tip|match|foot|football|pari/i;

// Réponses de salutation variées (naturel, pas robotique)
const GREET_REPLIES = [
  "Wesh 👋 Tu veux combien de matchs à analyser aujourd'hui ? (ex: 3, 5 ou 10)",
  "Salut ! 👋 Je te prépare des pronostics basés sur les vraies stats — tu veux analyser combien de matchs ?",
  "Hey ! ⚽ Prêt à analyser les matchs du jour. Combien tu en veux ? (1 à 10)",
  "Bonjour ! 🤖 Je scrappe les stats en temps réel. Dis-moi combien de matchs tu veux (ex: 5)",
  "Salam ! ⚽ Combien de matchs je t'analyse aujourd'hui ?",
];

function randomGreetReply(): string {
  return GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)];
}

function extractNumber(text: string): number | null {
  const m = text.match(/\b(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 10 ? n : null;
}

async function handle(chatId: number, text: string): Promise<void> {
  const raw   = text.trim();
  const lower = raw.toLowerCase().replace(/\s+/g, " ");

  // ── Commandes slash directes ───────────────────────
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

  const standMatch = lower.match(/^\/classement\s*(\w+)?/);
  if (standMatch) { await cmdStanding(chatId, standMatch[1] ?? "premier"); return; }

  const teamMatch = raw.match(/^\/equipe\s+(.+)/i);
  if (teamMatch) { await cmdTeam(chatId, teamMatch[1].trim()); return; }

  // ── Phase en cours : on attend un nombre ──────────
  const phase = await loadPhase(chatId);

  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, num);
      return;
    }
    // "oui" / "ok" → défaut 5 matchs
    if (/^(oui|ok|yes|vas[- ]?y|go|allez|top|super|parfait|let'?s?\s?go|yep|yup|bien\s?sûr|bah\s?oui)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, 5);
      return;
    }
    // "non" → annulation silencieuse
    if (/^(non|no|annule|stop|cancel|rien|nope|nan)$/i.test(raw)) {
      await savePhase(chatId, "idle");
      await send(chatId, "Pas de souci 👌 Dis-moi quand tu veux des pronostics.");
      return;
    }
    // Salutation dans la phase → redemander poliment
    if (GREETING.test(raw)) {
      await send(chatId, "😄 Tu veux combien de matchs ? Donne-moi un chiffre entre 1 et 10.");
      return;
    }
    // Chiffre en toutes lettres
    const words: Record<string, number> = { un:1, une:1, deux:2, trois:3, quatre:4, cinq:5, six:6, sept:7, huit:8, neuf:9, dix:10 };
    const wordNum = words[lower.trim()];
    if (wordNum) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, wordNum);
      return;
    }
    await send(chatId, "Donne-moi un chiffre entre 1 et 10 👇");
    return;
  }

  // ── Salutation → démarrer le flow naturellement ───
  if (GREETING.test(raw)) {
    await savePhase(chatId, "awaiting_count");
    await send(chatId, randomGreetReply());
    return;
  }

  // ── Message avec intention pronostic ──────────────
  if (PRONOS_INTENT.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPronosticPipeline(chatId, num);
      return;
    }
    // Contient une intention mais pas de chiffre → demander
    await savePhase(chatId, "awaiting_count");
    await send(chatId, "⚽ Sur combien de matchs tu veux que j'analyse ? (1 à 10)");
    return;
  }

  // ── Message court sans ponctuation = probablement une salutation ──
  if (raw.length <= 15 && !/[/\\@#]/.test(raw)) {
    await savePhase(chatId, "awaiting_count");
    await send(chatId, randomGreetReply());
    return;
  }

  // ── Fallback naturel — pas de commande robotique ──
  await send(chatId, "⚽ Dis-moi combien de matchs tu veux analyser (ex: <b>5</b>) et je lance le scraping !");
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot ⚽ — Scraping complet + Prédiction IA v4");

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
