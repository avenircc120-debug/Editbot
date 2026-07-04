// ═══════════════════════════════════════════════════════
//  FOOTBOT v8 — Google Sheets OAuth2 + Groq + ESPN Live
//  ┌─────────────────────────────────────────────────────┐
//  │  Stats      → Google Sheets API v4 (OAuth 2.0)     │
//  │  Live       → ESPN API (API publique, jamais bannie)│
//  │  Analyse IA → Groq llama-3.3-70b                   │
//  │  Sortie     → Telegram                             │
//  └─────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════

const TG_TOKEN            = Deno.env.get("TELEGRAM_BOT_TOKEN")       ?? "";
const GROQ_KEY            = Deno.env.get("GROQ_API_KEY")             ?? "";
const SB_URL              = Deno.env.get("SUPABASE_URL")             ?? "";
const SB_KEY              = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHEETS_ID           = Deno.env.get("GOOGLE_SHEETS_ID")         ?? "";
const GOOGLE_CLIENT_ID    = Deno.env.get("GOOGLE_CLIENT_ID")         ?? "";
const GOOGLE_CLIENT_SECRET= Deno.env.get("GOOGLE_CLIENT_SECRET")     ?? "";
const GOOGLE_REFRESH_TOKEN= Deno.env.get("GOOGLE_REFRESH_TOKEN")     ?? "";

const TG          = `https://api.telegram.org/bot${TG_TOKEN}`;
const GROQ_MODEL  = "llama-3.3-70b-versatile";
const GROQ_FAST   = "llama-3.1-8b-instant";
const ESPN_BASE   = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_HDR    = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Mapping ligues ────────────────────────────────────
const LEAGUES: Record<string, string> = {
  "premier league": "eng.1",  "pl": "eng.1",    "angleterre": "eng.1", "epl": "eng.1",
  "la liga":        "esp.1",  "liga": "esp.1",   "espagne": "esp.1",
  "ligue 1":        "fra.1",  "ligue1": "fra.1", "france": "fra.1",
  "bundesliga":     "ger.1",  "allemagne": "ger.1",
  "serie a":        "ita.1",  "italie": "ita.1",
  "champions league": "uefa.champions", "ldc": "uefa.champions",
  "ucl": "uefa.champions",    "ligue des champions": "uefa.champions",
  "europa league":  "uefa.europa", "el": "uefa.europa", "ligue europa": "uefa.europa",
  "conference league": "uefa.europa.conf", "uecl": "uefa.europa.conf",
  "mls": "usa.1",             "eredivisie": "ned.1",
};

const LEAGUE_TABS: Record<string, string> = {
  "eng.1":            "PL_Stand",
  "esp.1":            "Liga_Stand",
  "fra.1":            "L1_Stand",
  "ger.1":            "Bund_Stand",
  "ita.1":            "SA_Stand",
  "uefa.champions":   "UCL_Stand",
  "uefa.europa":      "EL_Stand",
  "uefa.europa.conf": "UECL_Stand",
  "usa.1":            "MLS_Stand",
  "ned.1":            "Eredivisie_Stand",
};

function detectLeague(text: string): string {
  const lower = text.toLowerCase();
  const sorted = Object.entries(LEAGUES).sort((a, b) => b[0].length - a[0].length);
  for (const [key, slug] of sorted) {
    if (key.length <= 4) {
      if (new RegExp(`(?<![a-z])${key}(?![a-z])`, "i").test(lower)) return slug;
    } else {
      if (lower.includes(key)) return slug;
    }
  }
  return "fra.1";
}

// ══════════════════════════════════════════════════════
//  COUCHE 1 : GOOGLE SHEETS API v4 — OAuth 2.0
//  Le bot ne scrape JAMAIS les sites de stats directement.
//  Il lit les données extraites par IMPORTHTML dans Sheets.
// ══════════════════════════════════════════════════════

let _cachedToken: { token: string; expiresAt: number } | null = null;

/** Obtient un access token Google via le refresh token OAuth 2.0 */
async function fetchGoogleAccessToken(): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return "";
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) return "";
  const d = await res.json();
  if (!d.access_token) return "";
  _cachedToken = { token: d.access_token, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return d.access_token;
}

async function getGoogleAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && _cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) {
    return _cachedToken.token;
  }
  _cachedToken = null;
  try { return await fetchGoogleAccessToken(); } catch { return ""; }
}

/** Lit une plage d'un onglet Google Sheets via l'API v4 (OAuth 2.0).
 *  Sur 401/403 : invalide le cache et retente une seule fois. */
async function sheetsRead(tab: string, range = "A1:Z100"): Promise<string[][]> {
  if (!SHEETS_ID) return [];

  const doFetch = async (token: string): Promise<Response | null> => {
    const enc  = encodeURIComponent(`${tab}!${range}`);
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${enc}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      clearTimeout(timer);
      return r;
    } catch { clearTimeout(timer); return null; }
  };

  let token = await getGoogleAccessToken();
  if (!token) return [];

  let r = await doFetch(token);
  // Si le token est expiré / rejeté, on force un refresh et on retente une fois
  if (r && (r.status === 401 || r.status === 403)) {
    token = await getGoogleAccessToken(true);
    if (!token) return [];
    r = await doFetch(token);
  }
  if (!r || !r.ok) return [];
  const d = await r.json();
  return (d.values ?? []) as string[][];
}

function sheetToText(rows: string[][], sep = " | "): string {
  if (!rows.length) return "Données non disponibles.";
  return rows.map(r => r.join(sep)).join("\n");
}

// ── Classement ────────────────────────────────────────
async function toolSheetsStandings(league: string): Promise<string> {
  const tab  = LEAGUE_TABS[league] ?? "L1_Stand";
  const rows = await sheetsRead(tab, "A1:K25");
  if (!rows.length) return `❌ Onglet <b>${tab}</b> vide ou introuvable dans Google Sheets.`;
  return `📊 <b>Classement</b>\n<pre>${sheetToText(rows)}</pre>`;
}

// ── Matchs du jour depuis Sheets ─────────────────────
async function toolSheetsMatchsToday(): Promise<string> {
  const rows = await sheetsRead("Matchs_Auj", "A1:H60");
  if (!rows.length) return "";
  return `📅 <b>Matchs du jour (Sheets)</b>\n<pre>${sheetToText(rows)}</pre>`;
}

// ── Infos équipe ──────────────────────────────────────
async function toolSheetsTeam(teamName: string): Promise<string> {
  const rows   = await sheetsRead("Equipes", "A1:J200");
  if (!rows.length) return `❌ Onglet <b>Equipes</b> introuvable.`;
  const lower  = teamName.toLowerCase();
  const header = rows[0] ?? [];
  const found  = rows.slice(1).filter(r => r[0]?.toLowerCase().includes(lower));
  if (!found.length) return `❓ <b>${teamName}</b> non trouvée dans l'onglet Equipes.`;
  return `🏟️ <b>${teamName}</b>\n<pre>${found.map(r => header.map((h, i) => `${h}: ${r[i] ?? "-"}`).join(" | ")).join("\n")}</pre>`;
}

// ── H2H ───────────────────────────────────────────────
async function toolSheetsH2H(home: string, away: string): Promise<string> {
  const rows  = await sheetsRead("H2H", "A1:J200");
  if (!rows.length) return `❌ Onglet <b>H2H</b> introuvable.`;
  const lh = home.toLowerCase(), la = away.toLowerCase();
  const found = rows.filter(r =>
    (r[0]?.toLowerCase().includes(lh) && r[2]?.toLowerCase().includes(la)) ||
    (r[0]?.toLowerCase().includes(la) && r[2]?.toLowerCase().includes(lh))
  );
  if (!found.length) return `❓ Pas d'historique H2H pour <b>${home} vs ${away}</b>.`;
  return `🆚 <b>H2H ${home} vs ${away}</b>\n<pre>${sheetToText(found)}</pre>`;
}

// ── Pronostics depuis l'onglet Pronostics ────────────
interface MatchProno {
  home: string; away: string; league: string; date: string;
  homeForm: string; awayForm: string; stats: string;
}

async function getSheetsPronoMatches(count: number): Promise<MatchProno[]> {
  // Colonnes : A=Domicile B=Extérieur C=Ligue D=Date E=Forme Dom F=Forme Ext G...=Stats
  const rows = await sheetsRead("Pronostics", `A2:J${count + 20}`);
  return rows
    .filter(r => r[0] && r[1])
    .slice(0, count)
    .map(r => ({
      home:     r[0] ?? "",
      away:     r[1] ?? "",
      league:   r[2] ?? "",
      date:     r[3] ?? "",
      homeForm: r[4] ?? "",
      awayForm: r[5] ?? "",
      stats:    r.slice(6).filter(Boolean).join(" | "),
    }));
}

// ══════════════════════════════════════════════════════
//  COUCHE 2 : ESPN API — Live & planning (temps réel)
// ══════════════════════════════════════════════════════

async function espnFetch(url: string, attempt = 0): Promise<any> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r     = await fetch(url, { headers: ESPN_HDR, signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 2) { await sleep(1500 * (attempt + 1)); return espnFetch(url, attempt + 1); }
    return null;
  } catch {
    if (attempt < 2) { await sleep(1000); return espnFetch(url, attempt + 1); }
    return null;
  }
}

async function toolEspnLiveScores(): Promise<string> {
  const leagues = ["eng.1","esp.1","fra.1","ger.1","ita.1","uefa.champions","uefa.europa"];
  const lines: string[] = [];
  await Promise.all(leagues.map(async (l) => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const sName = ev.status?.type?.name ?? "";
      if (!["STATUS_IN_PROGRESS","STATUS_HALFTIME"].includes(sName)) continue;
      const c    = ev.competitions?.[0];
      const home = c?.competitors?.find((x: any) => x.homeAway === "home");
      const away = c?.competitors?.find((x: any) => x.homeAway === "away");
      if (!home || !away) continue;
      lines.push(`⚽ ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (${ev.status?.type?.shortDetail ?? ""})`);
    }
  }));
  return lines.length ? `🔴 <b>En direct</b>\n${lines.join("\n")}` : "Aucun match en direct actuellement.";
}

async function toolEspnScheduleToday(): Promise<string> {
  const leagues = ["eng.1","esp.1","fra.1","ger.1","ita.1","uefa.champions","uefa.europa"];
  const lines: string[] = [];
  await Promise.all(leagues.map(async (l) => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const c      = ev.competitions?.[0];
      const home   = c?.competitors?.find((x: any) => x.homeAway === "home");
      const away   = c?.competitors?.find((x: any) => x.homeAway === "away");
      if (!home || !away) continue;
      const sName  = ev.status?.type?.name ?? "";
      const time   = ev.date ? new Date(ev.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : "";
      if (sName === "STATUS_FINAL")
        lines.push(`✅ ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (FT)`);
      else if (["STATUS_IN_PROGRESS","STATUS_HALFTIME"].includes(sName))
        lines.push(`🔴 ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (Live)`);
      else
        lines.push(`🕐 ${time} — ${home.team.shortDisplayName} vs ${away.team.shortDisplayName}`);
    }
  }));
  return lines.length ? `📅 <b>Matchs du jour</b>\n${lines.join("\n")}` : "Aucun match programmé aujourd'hui.";
}

// ══════════════════════════════════════════════════════
//  SUPABASE SESSION
// ══════════════════════════════════════════════════════

type Phase = "idle" | "awaiting_count";
interface ChatMessage { role: "user" | "assistant"; content: string; }

function sbH(): Record<string, string> {
  return { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
           "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" };
}

async function loadSession(chatId: number): Promise<{ phase: Phase; history: ChatMessage[] }> {
  if (!SB_URL || !SB_KEY) return { phase: "idle", history: [] };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase,history`, { headers: sbH() });
    if (!r.ok) return { phase: "idle", history: [] };
    const rows = await r.json() as any[];
    const row  = rows?.[0];
    let history: ChatMessage[] = [];
    try { history = row?.history ? JSON.parse(row.history) : []; } catch {}
    return { phase: (row?.phase as Phase) ?? "idle", history };
  } catch { return { phase: "idle", history: [] }; }
}

async function saveSession(chatId: number, phase: Phase, history: ChatMessage[]): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method: "POST", headers: sbH(),
      body: JSON.stringify({ chat_id: chatId, phase, history: JSON.stringify(history.slice(-10)) }),
    });
  } catch {}
}

// ══════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════

async function send(chatId: number, text: string): Promise<void> {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    }).catch(() => {});
    if (chunks.length > 1) await sleep(300);
  }
}

async function typing(chatId: number): Promise<void> {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

interface CancelToken { cancel: () => void }
function keepTyping(chatId: number, maxMs: number): CancelToken {
  let done = false;
  (async () => {
    let elapsed = 0;
    while (!done && elapsed < maxMs) { await typing(chatId); await sleep(4000); elapsed += 4000; }
  })();
  return { cancel: () => { done = true; } };
}

// ══════════════════════════════════════════════════════
//  GROQ AGENT — Tool calling
// ══════════════════════════════════════════════════════

const TOOLS = [
  { type: "function", function: {
    name: "get_live_scores",
    description: "Scores des matchs en direct (temps réel ESPN). Pour /live ou questions sur matchs en cours.",
    parameters: { type: "object", properties: {} },
  }},
  { type: "function", function: {
    name: "get_matches_today",
    description: "Tous les matchs du jour (résultats + en cours + à venir).",
    parameters: { type: "object", properties: {} },
  }},
  { type: "function", function: {
    name: "get_standings",
    description: "Classement d'une ligue depuis Google Sheets. Ligues : Premier League, La Liga, Ligue 1, Bundesliga, Serie A, Champions League, Europa League.",
    parameters: { type: "object", properties: { league: { type: "string", description: "Nom de la ligue (fr ou en)" } }, required: ["league"] },
  }},
  { type: "function", function: {
    name: "get_team_info",
    description: "Infos et forme récente d'une équipe depuis Google Sheets.",
    parameters: { type: "object", properties: { team: { type: "string", description: "Nom de l'équipe" } }, required: ["team"] },
  }},
  { type: "function", function: {
    name: "get_h2h",
    description: "Historique confrontations directes (H2H) entre deux équipes depuis Google Sheets.",
    parameters: { type: "object", properties: {
      home: { type: "string", description: "Première équipe" },
      away: { type: "string", description: "Deuxième équipe" },
    }, required: ["home","away"] },
  }},
];

const SYSTEM_PROMPT = `Tu es FootBot ⚽, expert en analyse football. Tu réponds toujours en français.
Sources de données :
- Google Sheets (classements, forme équipes, H2H, matchs programmés) — données IMPORTHTML automatiques
- ESPN API (scores en direct uniquement) — temps réel

Règles absolues :
1. Ne fabrique JAMAIS de scores, classements ou statistiques.
2. Si les données Sheets sont vides, dis-le clairement — ne suppose rien.
3. Pour les pronostics : utilise uniquement les données des outils.
4. Sois concis, précis, utilise des emojis football.`;

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "get_live_scores":   return toolEspnLiveScores();
    case "get_matches_today": return toolEspnScheduleToday();
    case "get_standings":     return toolSheetsStandings(detectLeague(args.league ?? ""));
    case "get_team_info":     return toolSheetsTeam(args.team ?? "");
    case "get_h2h":           return toolSheetsH2H(args.home ?? "", args.away ?? "");
    default:                  return "Outil inconnu.";
  }
}

async function groqAgentLoop(chatId: number, userMsg: string, history: ChatMessage[], firstName?: string): Promise<string> {
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT + (firstName ? `\nL'utilisateur s'appelle ${firstName}.` : "") },
    ...history.slice(-8),
    { role: "user", content: userMsg },
  ];
  for (let i = 0; i < 5; i++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, tools: TOOLS, tool_choice: "auto", max_tokens: 1024 }),
    });
    if (!res.ok) return "❌ Erreur IA. Réessaie dans quelques secondes.";
    const data   = await res.json();
    const choice = data.choices?.[0];
    const msg    = choice?.message;
    if (!msg) break;
    messages.push(msg);
    if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments ?? "{}"); } catch {}
        messages.push({ role: "tool", content: await executeTool(tc.function.name, args), tool_call_id: tc.id });
      }
      continue;
    }
    return msg.content ?? "";
  }
  return "Je n'ai pas pu obtenir une réponse. Réessaie.";
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRONOSTICS — Sheets → Groq → Telegram
// ══════════════════════════════════════════════════════

async function analyseMatchGroq(m: MatchProno): Promise<{ market: string; choice: string; confidence: number; reason: string }> {
  const prompt = `Analyse ce match :
⚽ ${m.home} vs ${m.away}  🏆 ${m.league || "?"} — ${m.date || "?"}
📊 Forme ${m.home} : ${m.homeForm || "N/A"}
📊 Forme ${m.away} : ${m.awayForm || "N/A"}
📈 Stats : ${m.stats || "Aucune donnée supplémentaire"}

Réponds UNIQUEMENT en JSON valide :
{"market":"1X2 ou BTTS ou Over/Under 2.5","choice":"sélection précise","confidence":70,"reason":"2 phrases max"}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_FAST, temperature: 0.2, max_tokens: 220,
      messages: [
        { role: "system", content: "Expert football. Réponds uniquement en JSON valide." },
        { role: "user",   content: prompt },
      ],
    }),
  });
  if (!res.ok) return { market: "1X2", choice: m.home, confidence: 55, reason: "Données insuffisantes." };
  const d = await res.json();
  try {
    const txt  = d.choices?.[0]?.message?.content ?? "{}";
    const json = txt.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    return JSON.parse(json);
  } catch { return { market: "1X2", choice: m.home, confidence: 55, reason: "Analyse impossible." }; }
}

function confBar(pct: number): string {
  const f = Math.min(Math.round(pct / 10), 10);
  return "█".repeat(f) + "░".repeat(10 - f) + ` ${pct}%`;
}

async function runPipeline(chatId: number, count: number): Promise<void> {
  await send(chatId, `⏳ Analyse de <b>${count} match${count > 1 ? "s" : ""}</b> depuis Google Sheets...`);
  const tok = keepTyping(chatId, 180_000);
  try {
    const matches = await getSheetsPronoMatches(count);
    if (!matches.length) {
      tok.cancel();
      await send(chatId,
        "❌ <b>Onglet Pronostics vide ou introuvable.</b>\n\n" +
        "L'onglet <b>Pronostics</b> doit contenir :\n" +
        "A=Domicile | B=Extérieur | C=Ligue | D=Date | E=Forme Dom | F=Forme Ext"
      );
      return;
    }
    // Concurrence limitée à 3 appels Groq simultanés pour éviter 429/timeouts
    const analyses: Awaited<ReturnType<typeof analyseMatchGroq>>[] = [];
    const CONCURRENCY = 3;
    for (let j = 0; j < matches.length; j += CONCURRENCY) {
      const batch = await Promise.all(matches.slice(j, j + CONCURRENCY).map(m => analyseMatchGroq(m)));
      analyses.push(...batch);
      if (j + CONCURRENCY < matches.length) await sleep(500);
    }
    tok.cancel();
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i], a = analyses[i];
      await send(chatId,
        `⚽ <b>${m.home} vs ${m.away}</b>\n` +
        `🏆 ${m.league || "?"} · ${m.date || "?"}\n` +
        `📊 Forme : ${m.homeForm || "?"} / ${m.awayForm || "?"}\n` +
        `───────────────────────\n` +
        `📌 Marché : <b>${a.market}</b>\n` +
        `✅ Pronostic : <b>${a.choice}</b>\n` +
        `📈 Confiance : ${confBar(a.confidence)}\n` +
        `💬 ${a.reason}`
      );
      if (i < matches.length - 1) await sleep(400);
    }
  } catch {
    tok.cancel();
    await send(chatId, "❌ Erreur lors de l'analyse. Réessaie.");
  }
}

// ══════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════

const MATCH_COUNT_RE = /(\d+)\s*match/i;

function extractNumber(text: string): number | null {
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= 20 ? n : null;
}

async function handle(chatId: number, raw: string, firstName?: string): Promise<void> {
  const lower = raw.toLowerCase().trim();
  const { phase, history } = await loadSession(chatId);

  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    await saveSession(chatId, "idle", history);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // Salutation
  if (/^(salut|bonjour|hello|bonsoir|hi|coucou|start|\/start)$/i.test(lower)) {
    const name = firstName ? ` ${firstName}` : "";
    await send(chatId,
      `⚽ Bienvenue${name} sur <b>FootBot v8</b> !\n\n` +
      `📡 Données : Google Sheets + ESPN Live\n\n` +
      `<b>Commandes :</b>\n` +
      `/live — Matchs en direct\n/auj — Matchs du jour\n` +
      `/classement [ligue] — Classement\n/equipe [nom] — Infos équipe\n` +
      `/h2h [e1] vs [e2] — Confrontations\n/pronostic [e1] vs [e2] — Analyse IA\n\n` +
      `💡 Envoie un chiffre (ex: <b>3</b>) pour 3 pronostics depuis Google Sheets !`
    );
    return;
  }

  if (/^\/live/i.test(lower) || lower === "live") {
    const tok = keepTyping(chatId, 30_000);
    const res = await toolEspnLiveScores();
    tok.cancel(); await send(chatId, res); return;
  }

  if (/^\/auj/i.test(lower) || lower === "auj") {
    const tok = keepTyping(chatId, 30_000);
    const sheetsData = await toolSheetsMatchsToday();
    const res = sheetsData || await toolEspnScheduleToday();
    tok.cancel(); await send(chatId, res); return;
  }

  if (/^\/classement/i.test(lower)) {
    const query  = raw.replace(/\/classement/i, "").trim() || "ligue 1";
    const tok    = keepTyping(chatId, 30_000);
    const res    = await toolSheetsStandings(detectLeague(query));
    tok.cancel(); await send(chatId, res); return;
  }

  if (/^\/equipe/i.test(lower)) {
    const team = raw.replace(/\/equipe/i, "").trim();
    if (!team) { await send(chatId, "Usage : /equipe PSG"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsTeam(team);
    tok.cancel(); await send(chatId, res); return;
  }

  if (/^\/h2h/i.test(lower)) {
    const parts = raw.replace(/\/h2h/i, "").trim().split(/\s+vs\s+/i);
    if (parts.length < 2) { await send(chatId, "Usage : /h2h PSG vs OM"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsH2H(parts[0].trim(), parts[1].trim());
    tok.cancel(); await send(chatId, res); return;
  }

  if (/^\/pronostic/i.test(lower)) {
    const parts = raw.replace(/\/pronostic/i, "").trim().split(/\s+vs\s+/i);
    if (parts.length < 2) { await send(chatId, "Usage : /pronostic PSG vs OM"); return; }
    const tok = keepTyping(chatId, 60_000);
    const [h2h, teamA, teamB] = await Promise.all([
      toolSheetsH2H(parts[0].trim(), parts[1].trim()),
      toolSheetsTeam(parts[0].trim()),
      toolSheetsTeam(parts[1].trim()),
    ]);
    tok.cancel();
    const m: MatchProno = { home: parts[0].trim(), away: parts[1].trim(), league: "?", date: "Prochain match", homeForm: teamA, awayForm: teamB, stats: h2h };
    const tok2 = keepTyping(chatId, 30_000);
    const a    = await analyseMatchGroq(m);
    tok2.cancel();
    await send(chatId,
      `⚽ <b>${m.home} vs ${m.away}</b>\n` +
      `📌 Marché : <b>${a.market}</b>\n` +
      `✅ Pronostic : <b>${a.choice}</b>\n` +
      `📈 Confiance : ${confBar(a.confidence)}\n` +
      `💬 ${a.reason}`
    );
    return;
  }

  if (MATCH_COUNT_RE.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  if (/^\d+$/.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // Agent Groq
  const tok    = keepTyping(chatId, 60_000);
  const answer = await groqAgentLoop(chatId, raw, history, firstName);
  tok.cancel();
  if (answer) {
    await send(chatId, answer);
    await saveSession(chatId, "idle", [...history, { role: "user", content: raw }, { role: "assistant", content: answer }]);
  }
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot v8 ⚽ Google Sheets OAuth2 + Groq + ESPN Live");

  // Vérifie le secret webhook Telegram (protection contre les requêtes forgées)
  if (WEBHOOK_SECRET) {
    const incoming = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (incoming !== WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) {
      const firstName = m.from?.first_name ?? m.chat?.first_name ?? undefined;
      handle(m.chat.id, m.text.trim(), firstName).catch(console.error);
    }
    return new Response("OK");
  } catch { return new Response("OK"); }
});
