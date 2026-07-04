// ═══════════════════════════════════════════════════════
//  FOOTBOT v8 — Architecture Google Sheets + Groq + ESPN Live
//  ┌─────────────────────────────────────────────────────┐
//  │  Données stats  → Google Sheets (IMPORTHTML)        │
//  │  Scores live    → ESPN API (jamais banni)           │
//  │  Analyse IA     → Groq llama-3.3-70b               │
//  │  Sortie         → Telegram                         │
//  └─────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════

const TG_TOKEN   = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY   = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL     = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHEETS_KEY = Deno.env.get("GOOGLE_SHEETS_API_KEY") ?? "";
const SHEETS_ID  = Deno.env.get("GOOGLE_SHEETS_ID") ?? "";
const TG         = `https://api.telegram.org/bot${TG_TOKEN}`;

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_FAST  = "llama-3.1-8b-instant";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Mapping ligues ────────────────────────────────────
const LEAGUES: Record<string, string> = {
  "premier league": "eng.1",  "pl": "eng.1",    "angleterre": "eng.1", "epl": "eng.1",
  "la liga": "esp.1",         "liga": "esp.1",   "espagne": "esp.1",
  "ligue 1": "fra.1",         "ligue1": "fra.1", "france": "fra.1",
  "bundesliga": "ger.1",      "allemagne": "ger.1",
  "serie a": "ita.1",         "italie": "ita.1",
  "champions league": "uefa.champions", "ldc": "uefa.champions",
  "ucl": "uefa.champions",    "ligue des champions": "uefa.champions",
  "europa league": "uefa.europa", "el": "uefa.europa", "ligue europa": "uefa.europa",
  "conference league": "uefa.europa.conf", "uecl": "uefa.europa.conf",
  "mls": "usa.1",             "eredivisie": "ned.1", "pays-bas": "ned.1",
};

// Nom de l'onglet Google Sheets pour chaque ligue
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
//  COUCHE 1 : GOOGLE SHEETS API v4
//  Le bot ne scrape jamais les sites de stats directement.
//  Il lit les données déjà extraites par Google Sheets
//  via ses formules IMPORTHTML / IMPORTXML.
// ══════════════════════════════════════════════════════

/**
 * Lit une plage d'un onglet Google Sheets via l'API v4.
 * Retourne [] si non configuré ou erreur réseau.
 */
async function sheetsRead(tab: string, range = "A1:Z100"): Promise<string[][]> {
  if (!SHEETS_KEY || !SHEETS_ID) return [];
  const enc = encodeURIComponent(`${tab}!${range}`);
  const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${enc}?key=${SHEETS_KEY}`;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r     = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.values ?? []) as string[][];
  } catch {
    return [];
  }
}

/** Formate les lignes d'un tableau Sheets en texte lisible. */
function sheetToText(rows: string[][], sep = " | "): string {
  if (!rows.length) return "Données non disponibles.";
  return rows.map(r => r.join(sep)).join("\n");
}

// ── Classement depuis Sheets ──────────────────────────
async function toolSheetsStandings(league: string): Promise<string> {
  const tab  = LEAGUE_TABS[league] ?? "L1_Stand";
  const rows = await sheetsRead(tab, "A1:K25");
  if (!rows.length) {
    return `❌ Classement indisponible pour cet onglet (${tab}).\nVérifie que l'onglet existe dans ton Google Sheets.`;
  }
  return `📊 <b>Classement</b>\n<pre>${sheetToText(rows)}</pre>`;
}

// ── Matchs du jour depuis Sheets ─────────────────────
async function toolSheetsMatchsToday(): Promise<string> {
  const rows = await sheetsRead("Matchs_Auj", "A1:H60");
  if (!rows.length) return "❌ Aucun match trouvé dans l'onglet <b>Matchs_Auj</b>.";
  return `📅 <b>Matchs du jour</b>\n<pre>${sheetToText(rows)}</pre>`;
}

// ── Infos équipe depuis Sheets ────────────────────────
async function toolSheetsTeam(teamName: string): Promise<string> {
  const rows  = await sheetsRead("Equipes", "A1:J200");
  if (!rows.length) return "❌ Onglet <b>Equipes</b> introuvable dans Google Sheets.";
  const lower  = teamName.toLowerCase();
  const header = rows[0];
  const found  = rows.slice(1).filter(r => r[0]?.toLowerCase().includes(lower));
  if (!found.length) return `❓ Équipe "<b>${teamName}</b>" non trouvée dans l'onglet Equipes.`;
  const formatted = found.map(r =>
    header.map((h, i) => `${h}: ${r[i] ?? "-"}`).join(" | ")
  ).join("\n");
  return `🏟️ <b>${teamName}</b>\n<pre>${formatted}</pre>`;
}

// ── H2H depuis Sheets ─────────────────────────────────
async function toolSheetsH2H(home: string, away: string): Promise<string> {
  const rows  = await sheetsRead("H2H", "A1:J200");
  if (!rows.length) return "❌ Onglet <b>H2H</b> introuvable dans Google Sheets.";
  const lh = home.toLowerCase();
  const la = away.toLowerCase();
  const found = rows.filter(r =>
    (r[0]?.toLowerCase().includes(lh) && r[2]?.toLowerCase().includes(la)) ||
    (r[0]?.toLowerCase().includes(la) && r[2]?.toLowerCase().includes(lh))
  );
  if (!found.length) return `❓ Pas d'historique H2H pour <b>${home} vs ${away}</b>.`;
  return `🆚 <b>H2H ${home} vs ${away}</b>\n<pre>${sheetToText(found)}</pre>`;
}

// ══════════════════════════════════════════════════════
//  COUCHE 2 : ESPN API — Scores live uniquement
//  L'API ESPN est publique et non bloquée.
//  On l'utilise UNIQUEMENT pour les données temps réel
//  (matchs en direct, résultats du jour).
// ══════════════════════════════════════════════════════

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_HDR  = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

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
  const leagues = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions", "uefa.europa"];
  const lines: string[] = [];
  await Promise.all(leagues.map(async (l) => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const status = ev.status?.type;
      const live   = ["STATUS_IN_PROGRESS", "STATUS_HALFTIME"].includes(status?.name ?? "");
      if (!live) continue;
      const c    = ev.competitions?.[0];
      const home = c?.competitors?.find((x: any) => x.homeAway === "home");
      const away = c?.competitors?.find((x: any) => x.homeAway === "away");
      if (!home || !away) continue;
      const clock = status?.shortDetail ?? "";
      lines.push(`⚽ ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (${clock})`);
    }
  }));
  return lines.length
    ? `🔴 <b>En direct</b>\n${lines.join("\n")}`
    : "Aucun match en direct actuellement.";
}

async function toolEspnScheduleToday(): Promise<string> {
  const leagues = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions", "uefa.europa"];
  const lines: string[] = [];
  await Promise.all(leagues.map(async (l) => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const c      = ev.competitions?.[0];
      const home   = c?.competitors?.find((x: any) => x.homeAway === "home");
      const away   = c?.competitors?.find((x: any) => x.homeAway === "away");
      if (!home || !away) continue;
      const status = ev.status?.type?.name ?? "";
      const time   = ev.date ? new Date(ev.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : "";
      if (status === "STATUS_FINAL") {
        lines.push(`✅ ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (FT)`);
      } else if (["STATUS_IN_PROGRESS", "STATUS_HALFTIME"].includes(status)) {
        lines.push(`🔴 ${home.team.shortDisplayName} ${home.score}–${away.score} ${away.team.shortDisplayName} (Live)`);
      } else {
        lines.push(`🕐 ${time} — ${home.team.shortDisplayName} vs ${away.team.shortDisplayName}`);
      }
    }
  }));
  return lines.length
    ? `📅 <b>Matchs du jour</b>\n${lines.join("\n")}`
    : "Aucun match programmé aujourd'hui.";
}

// ══════════════════════════════════════════════════════
//  SUPABASE SESSION
// ══════════════════════════════════════════════════════

type Phase = "idle" | "awaiting_count";
interface ChatMessage { role: "user" | "assistant"; content: string; }

function sbH(): Record<string, string> {
  return {
    "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
  };
}

async function loadSession(chatId: number): Promise<{ phase: Phase; history: ChatMessage[] }> {
  if (!SB_URL || !SB_KEY) return { phase: "idle", history: [] };
  try {
    const r    = await fetch(`${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase,history`, { headers: sbH() });
    if (!r.ok) return { phase: "idle", history: [] };
    const rows = await r.json() as any[];
    const row  = rows?.[0];
    let history: ChatMessage[] = [];
    try { history = row?.history ? JSON.parse(row.history) : []; } catch { history = []; }
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
  } catch { /* non bloquant */ }
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

interface CancelToken { cancel: () => void }

function keepTyping(chatId: number, maxMs: number): CancelToken {
  let done = false;
  (async () => {
    let elapsed = 0;
    while (!done && elapsed < maxMs) {
      await typing(chatId);
      await sleep(4000);
      elapsed += 4000;
    }
  })();
  return { cancel: () => { done = true; } };
}

// ══════════════════════════════════════════════════════
//  COUCHE 3 : GROQ AGENT — Tool calling
// ══════════════════════════════════════════════════════

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_live_scores",
      description: "Matchs de football en direct (temps réel via ESPN). Utiliser pour /live ou questions sur matchs en cours.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_matches_today",
      description: "Tous les matchs du jour (résultats + en cours + à venir). Utiliser pour /auj.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_standings",
      description: "Classement d'une ligue depuis Google Sheets. Disponible : Premier League, La Liga, Ligue 1, Bundesliga, Serie A, Champions League, Europa League.",
      parameters: {
        type: "object",
        properties: { league: { type: "string", description: "Nom de la ligue (français ou anglais)" } },
        required: ["league"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_team_info",
      description: "Infos et forme récente d'une équipe depuis Google Sheets.",
      parameters: {
        type: "object",
        properties: { team: { type: "string", description: "Nom de l'équipe" } },
        required: ["team"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_h2h",
      description: "Historique des confrontations directes (H2H) entre deux équipes depuis Google Sheets.",
      parameters: {
        type: "object",
        properties: {
          home: { type: "string", description: "Première équipe" },
          away: { type: "string", description: "Deuxième équipe" },
        },
        required: ["home", "away"],
      },
    },
  },
];

const SYSTEM_PROMPT = `Tu es FootBot ⚽, expert en analyse football. Tu réponds toujours en français.
Tes données viennent de deux sources fiables :
- Google Sheets (classements, form, H2H, stats équipes) — mis à jour automatiquement via IMPORTHTML
- ESPN API (scores en direct) — temps réel

Règles absolues :
1. Ne fabrique JAMAIS de scores, classements ou stats. Si les données manquent, dis-le clairement.
2. Pour les pronostics : base-toi uniquement sur les données des outils, jamais sur ta mémoire.
3. Sois concis, précis et utilise des emojis football pour la lisibilité.
4. Évite les listes interminables — va droit au but.`;

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

async function groqAgentLoop(
  chatId: number,
  userMsg: string,
  history: ChatMessage[],
  firstName?: string
): Promise<string> {
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
        const result = await executeTool(tc.function.name, args);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
      continue;
    }
    return msg.content ?? "";
  }
  return "Je n'ai pas pu obtenir une réponse. Réessaie.";
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRONOSTICS
//  Flux : Google Sheets (Pronostics) → Groq AI → Telegram
//  L'onglet "Pronostics" contient les matchs à analyser
//  avec leurs stats (forme, buts, cotes...).
// ══════════════════════════════════════════════════════

interface MatchProno {
  home: string; away: string; league: string; date: string;
  homeForm: string; awayForm: string; stats: string;
}

async function getSheetsPronoMatches(count: number): Promise<MatchProno[]> {
  // Onglet "Pronostics" : colonnes A=Domicile, B=Extérieur, C=Ligue,
  // D=Date, E=Forme Dom, F=Forme Ext, G...=Stats supp
  const rows = await sheetsRead("Pronostics", `A2:J${count + 20}`);
  return rows
    .filter(r => r[0] && r[1]) // au moins domicile + extérieur
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

async function analyseMatchGroq(m: MatchProno): Promise<{ market: string; choice: string; confidence: number; reason: string }> {
  const prompt = `Analyse ce match et fournis un pronostic :

⚽ ${m.home} vs ${m.away}
🏆 ${m.league || "Ligue inconnue"} — ${m.date || "Date inconnue"}
📊 Forme ${m.home} : ${m.homeForm || "N/A"}
📊 Forme ${m.away} : ${m.awayForm || "N/A"}
📈 Stats : ${m.stats || "Aucune donnée supplémentaire"}

Réponds UNIQUEMENT en JSON valide :
{"market":"1X2 ou BTTS ou Over/Under 2.5","choice":"ta sélection précise","confidence":70,"reason":"2 phrases max justifiant le choix"}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_FAST,
      messages: [
        { role: "system", content: "Expert football. Réponds uniquement en JSON valide, sans commentaire." },
        { role: "user", content: prompt },
      ],
      max_tokens: 220, temperature: 0.2,
    }),
  });
  if (!res.ok) return { market: "1X2", choice: m.home, confidence: 55, reason: "Données insuffisantes." };
  const d = await res.json();
  try {
    const txt  = d.choices?.[0]?.message?.content ?? "{}";
    const json = txt.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    return JSON.parse(json);
  } catch {
    return { market: "1X2", choice: m.home, confidence: 55, reason: "Analyse impossible." };
  }
}

function confBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "█".repeat(Math.min(filled, 10)) + "░".repeat(Math.max(0, 10 - filled)) + ` ${pct}%`;
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
        "Assure-toi que l'onglet <b>Pronostics</b> de ton Google Sheets contient :\n" +
        "Colonne A = Domicile | B = Extérieur | C = Ligue | D = Date | E = Forme Dom | F = Forme Ext"
      );
      return;
    }

    const analyses = await Promise.all(matches.map(m => analyseMatchGroq(m)));
    tok.cancel();

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const a = analyses[i];
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

  // ── Attente confirmation nombre ───────────────────
  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    await saveSession(chatId, "idle", history);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // ── Salutation ────────────────────────────────────
  if (/^(salut|bonjour|hello|bonsoir|hi|coucou|start|\/start)$/i.test(lower)) {
    const name = firstName ? ` ${firstName}` : "";
    await send(chatId,
      `⚽ Bienvenue${name} sur <b>FootBot v8</b> !\n\n` +
      `📡 Données via Google Sheets + ESPN Live\n\n` +
      `<b>Commandes :</b>\n` +
      `/live — Matchs en direct\n` +
      `/auj — Matchs du jour\n` +
      `/classement [ligue] — Classement\n` +
      `/equipe [nom] — Infos équipe\n` +
      `/h2h [e1] vs [e2] — Confrontations\n` +
      `/pronostic [e1] vs [e2] — Analyse IA\n\n` +
      `💡 Envoie un chiffre (ex: <b>3</b>) pour 3 pronostics depuis le Sheets !`
    );
    return;
  }

  // ── Commandes slash ───────────────────────────────
  if (/^\/live/i.test(lower) || lower === "live") {
    const tok = keepTyping(chatId, 30_000);
    const res = await toolEspnLiveScores();
    tok.cancel();
    await send(chatId, res);
    return;
  }

  if (/^\/auj/i.test(lower) || lower === "auj") {
    const tok = keepTyping(chatId, 30_000);
    // Essaye d'abord les Sheets, sinon ESPN
    const sheetsData = await toolSheetsMatchsToday();
    const hasSheetsData = !sheetsData.includes("❌");
    const res = hasSheetsData ? sheetsData : await toolEspnScheduleToday();
    tok.cancel();
    await send(chatId, res);
    return;
  }

  if (/^\/classement/i.test(lower)) {
    const query  = raw.replace(/\/classement/i, "").trim() || "ligue 1";
    const league = detectLeague(query);
    const tok    = keepTyping(chatId, 30_000);
    const res    = await toolSheetsStandings(league);
    tok.cancel();
    await send(chatId, res);
    return;
  }

  if (/^\/equipe/i.test(lower)) {
    const team = raw.replace(/\/equipe/i, "").trim();
    if (!team) { await send(chatId, "Usage : /equipe PSG"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsTeam(team);
    tok.cancel();
    await send(chatId, res);
    return;
  }

  if (/^\/h2h/i.test(lower)) {
    const parts = raw.replace(/\/h2h/i, "").trim().split(/\s+vs\s+/i);
    if (parts.length < 2) { await send(chatId, "Usage : /h2h PSG vs OM"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsH2H(parts[0].trim(), parts[1].trim());
    tok.cancel();
    await send(chatId, res);
    return;
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
    const m: MatchProno = {
      home: parts[0].trim(), away: parts[1].trim(),
      league: "?", date: "Prochain match",
      homeForm: teamA, awayForm: teamB, stats: h2h,
    };
    const tok2 = keepTyping(chatId, 30_000);
    const a    = await analyseMatchGroq(m);
    tok2.cancel();
    await send(chatId,
      `⚽ <b>${m.home} vs ${m.away}</b>\n` +
      `───────────────────────\n` +
      `📌 Marché : <b>${a.market}</b>\n` +
      `✅ Pronostic : <b>${a.choice}</b>\n` +
      `📈 Confiance : ${confBar(a.confidence)}\n` +
      `💬 ${a.reason}`
    );
    return;
  }

  // ── Mots-clés paris + nombre ──────────────────────
  if (MATCH_COUNT_RE.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // ── Chiffre seul → pronostics ─────────────────────
  if (/^\d+$/.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // ── Agent Groq avec outils + historique ──────────
  const tok    = keepTyping(chatId, 60_000);
  const answer = await groqAgentLoop(chatId, raw, history, firstName);
  tok.cancel();

  if (answer) {
    await send(chatId, answer);
    await saveSession(chatId, "idle", [
      ...history,
      { role: "user",      content: raw    },
      { role: "assistant", content: answer },
    ]);
  }
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot v8 ⚽ Google Sheets + Groq + ESPN Live — Zéro scraping direct");
  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) {
      const firstName = m.from?.first_name ?? m.chat?.first_name ?? undefined;
      handle(m.chat.id, m.text.trim(), firstName).catch(console.error);
    }
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
