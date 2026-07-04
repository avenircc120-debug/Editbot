// ═══════════════════════════════════════════════════════
//  FOOTBOT v7 — Agent Groq avec Tool Calling
//  Groq choisit ses propres outils : web search, ESPN data, etc.
//  Pipeline pronostics complet conservé (ESPN stats + IA)
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG       = `https://api.telegram.org/bot${TG_TOKEN}`;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_V2   = "https://site.api.espn.com/apis/v2/sports/soccer";
const ESPN_HDR  = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

// Modèle Groq pour le tool calling (supporte les function calls)
const GROQ_MODEL = "llama-3.3-70b-versatile";
// Modèle rapide pour l'analyse pronostics
const GROQ_FAST  = "llama-3.1-8b-instant";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── ESPN leagues slug mapping ─────────────────────────
const LEAGUES: Record<string, string> = {
  "premier league": "eng.1",  "pl": "eng.1",         "angleterre": "eng.1", "epl": "eng.1",
  "la liga": "esp.1",         "liga": "esp.1",        "espagne": "esp.1",
  "ligue 1": "fra.1",         "ligue1": "fra.1",      "france": "fra.1",
  "bundesliga": "ger.1",      "allemagne": "ger.1",
  "serie a": "ita.1",         "italie": "ita.1",
  "champions league": "uefa.champions", "ldc": "uefa.champions",  "ucl": "uefa.champions", "ligue des champions": "uefa.champions",
  "europa league": "uefa.europa", "ligue europa": "uefa.europa", "el": "uefa.europa",
  "conference league": "uefa.europa.conf", "uecl": "uefa.europa.conf",
  "mls": "usa.1",
  "eredivisie": "ned.1",      "pays-bas": "ned.1",
  "liga portugal": "por.1",   "portugal": "por.1",
  "world cup": "fifa.world",  "coupe du monde": "fifa.world", "cdm": "fifa.world",
  "afcon": "caf.nations",     "coupe d'afrique": "caf.nations", "can": "caf.nations",
  "nations league": "uefa.nations", "ligue des nations": "uefa.nations",
};

function detectLeague(text: string): string {
  const lower = text.toLowerCase();
  const sorted = Object.entries(LEAGUES).sort((a, b) => b[0].length - a[0].length);
  for (const [key, slug] of sorted) {
    if (key.length <= 4) {
      const re = new RegExp(`(?<![a-z])${key}(?![a-z])`, "i");
      if (re.test(lower)) return slug;
    } else {
      if (lower.includes(key)) return slug;
    }
  }
  return "fra.1";
}

// ── Fetch ESPN avec timeout + retry ──────────────────
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

// ── Fetch générique avec timeout (pour DuckDuckGo etc.) ─
async function safeFetch(url: string, attempt = 0): Promise<any> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const r     = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FootBot/7.0)" },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (r.ok) return r.json();
    return null;
  } catch {
    if (attempt < 1) { await sleep(800); return safeFetch(url, attempt + 1); }
    return null;
  }
}

const todayESPN = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const fmtTime   = (d: string) => new Date(d).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

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
function keepTyping(chatId: number, durationMs: number): void {
  // Fire-and-forget: maintient l'indicateur de frappe en boucle
  (async () => {
    let elapsed = 0;
    while (elapsed < durationMs) {
      await typing(chatId);
      await sleep(4000);
      elapsed += 4000;
    }
  })().catch(() => {});
}

// ══════════════════════════════════════════════════════
//  OUTILS GROQ — Implémentations
// ══════════════════════════════════════════════════════

/** Recherche web via DuckDuckGo Instant Answer (sans clé API) */
async function toolWebSearch(query: string): Promise<string> {
  // DuckDuckGo Instant Answer — requête simple sans site: (non supporté par cet endpoint)
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=fr-fr`;
  const data = await safeFetch(url);
  if (!data) return "Aucun résultat trouvé pour cette recherche.";

  const parts: string[] = [];
  if (data.AbstractText)  parts.push(data.AbstractText);
  if (data.Answer)        parts.push(`Réponse directe: ${data.Answer}`);
  if (data.Definition)    parts.push(data.Definition);

  const topics: any[] = data.RelatedTopics ?? [];
  for (const t of topics.slice(0, 6)) {
    if (t.Text && t.Text.length > 10) parts.push(t.Text);
    else if (t.Topics) {
      for (const sub of (t.Topics ?? []).slice(0, 3)) {
        if (sub.Text) parts.push(sub.Text);
      }
    }
  }

  const results: any[] = data.Results ?? [];
  for (const r of results.slice(0, 3)) {
    if (r.Text) parts.push(r.Text);
  }

  if (!parts.length) return `Aucun résultat web pertinent trouvé pour "${query}".`;
  return parts.slice(0, 8).join("\n\n").slice(0, 2000);
}

/** Classement d'une ligue ESPN */
async function toolEspnStandings(league: string): Promise<string> {
  const slug = LEAGUES[league.toLowerCase()] ?? league;
  const data = await espnFetch(`${ESPN_V2}/${slug}/standings`);
  if (!data) return `Impossible de charger le classement pour ${league}.`;

  const hasChildren = Array.isArray(data.children) && data.children.length > 0 && data.children[0]?.standings?.entries;
  const hasFlat     = Array.isArray(data.standings?.entries) && data.standings.entries.length > 0;
  const leagueName  = data.name ?? slug;

  const formatEntry = (entry: any, pos: number): string => {
    const team  = entry.team?.displayName ?? entry.team?.shortDisplayName ?? "?";
    const stats = entry.stats ?? [];
    const get   = (names: string[]) => names.map(n => stats.find((s: any) => s.name === n || s.abbreviation === n)?.value).find(v => v !== undefined) ?? "?";
    const pts   = get(["points", "PTS"]);
    const pld   = get(["gamesPlayed", "GP"]);
    const w     = get(["wins", "W"]);
    const d     = get(["ties", "D"]);
    const l     = get(["losses", "L"]);
    const gd    = get(["goalDifference"]);
    const gdStr = gd !== "?" ? ` GD:${Number(gd) > 0 ? "+" : ""}${gd}` : "";
    return `${pos}. ${team} | ${pts}pts | ${pld}J ${w}V${d}N${l}D${gdStr}`;
  };

  const lines: string[] = [`=== Classement ${leagueName} ===`];

  if (hasChildren) {
    for (const group of data.children) {
      if (group.name) lines.push(`\n-- ${group.name} --`);
      (group.standings?.entries ?? []).slice(0, 20).forEach((e: any, i: number) => lines.push(formatEntry(e, i + 1)));
    }
  } else if (hasFlat) {
    data.standings.entries.slice(0, 20).forEach((e: any, i: number) => lines.push(formatEntry(e, i + 1)));
  } else {
    return `Classement non disponible pour ${league}.`;
  }

  return lines.join("\n").slice(0, 2000);
}

/** Scores en direct */
async function toolEspnLiveScores(): Promise<string> {
  const slugs = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions", "uefa.europa"];
  const results: string[] = [];

  await Promise.all(slugs.map(async (slug) => {
    const data = await espnFetch(`${ESPN_BASE}/${slug}/scoreboard?dates=${todayESPN()}`);
    for (const ev of data?.events ?? []) {
      const comp  = ev.competitions?.[0];
      if (comp?.status?.type?.state !== "in") continue;
      const home  = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const away  = comp?.competitors?.find((c: any) => c.homeAway === "away");
      const clock = comp?.status?.displayClock ?? "";
      const league = data?.leagues?.[0]?.abbreviation ?? slug;
      results.push(`[${league}] ${home?.team?.displayName ?? "?"} ${home?.score ?? 0}-${away?.score ?? 0} ${away?.team?.displayName ?? "?"} (${clock})`);
    }
  }));

  return results.length ? `=== Scores Live ===\n${results.join("\n")}` : "Aucun match en direct en ce moment.";
}

/** Programme du jour */
async function toolEspnSchedule(league?: string): Promise<string> {
  const slugs = league
    ? [LEAGUES[league.toLowerCase()] ?? league]
    : ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1", "uefa.champions", "uefa.europa", "caf.nations", "fifa.world"];

  const lines: string[] = ["=== Programme du jour ==="];

  await Promise.all(slugs.map(async (slug) => {
    const data = await espnFetch(`${ESPN_BASE}/${slug}/scoreboard?dates=${todayESPN()}`);
    const events: any[] = (data?.events ?? []).filter((e: any) =>
      ["pre", "in"].includes(e.competitions?.[0]?.status?.type?.state)
    );
    if (!events.length) return;
    const leagueName = data?.leagues?.[0]?.name ?? slug;
    lines.push(`\n[${leagueName}]`);
    for (const ev of events) {
      const comp  = ev.competitions?.[0];
      const state = comp?.status?.type?.state;
      const home  = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const away  = comp?.competitors?.find((c: any) => c.homeAway === "away");
      const time  = comp?.startDate ? fmtTime(comp.startDate) : "?";
      const score = state === "in"
        ? `${home?.score ?? 0}-${away?.score ?? 0} (LIVE)`
        : time;
      lines.push(`  ${score} — ${home?.team?.displayName ?? "?"} vs ${away?.team?.displayName ?? "?"}`);
    }
  }));

  return lines.join("\n").slice(0, 2000) || "Aucun match programmé aujourd'hui.";
}

/** Actualités ESPN */
async function toolEspnNews(): Promise<string> {
  const data = await espnFetch(`${ESPN_BASE}/news?limit=8`);
  const articles: any[] = data?.articles ?? [];
  if (!articles.length) return "Impossible de charger les actualités ESPN.";

  const lines = ["=== Actualités Football ==="];
  articles.slice(0, 6).forEach((a, i) => {
    const title = a.headline ?? a.title ?? "?";
    const desc  = (a.description ?? a.summary ?? "").slice(0, 120);
    lines.push(`\n${i + 1}. ${title}`);
    if (desc) lines.push(`   ${desc}${desc.length >= 120 ? "..." : ""}`);
  });
  return lines.join("\n").slice(0, 2000);
}

/** Info équipe ESPN */
async function toolEspnTeam(teamName: string): Promise<string> {
  const slugs = ["eng.1", "esp.1", "fra.1", "ger.1", "ita.1"];
  for (const slug of slugs) {
    const data = await espnFetch(`${ESPN_BASE}/${slug}/teams`);
    const teams: any[] = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const match = teams.find((t: any) => {
      const name = (t.team?.displayName ?? t.team?.name ?? "").toLowerCase();
      return name.includes(teamName.toLowerCase()) || teamName.toLowerCase().includes(name.split(" ")[0]);
    });
    if (match) {
      const team = match.team;
      const info = [
        `=== ${team.displayName} ===`,
        `Abréviation: ${team.abbreviation ?? "?"}`,
        team.venue?.fullName ? `Stade: ${team.venue.fullName}` : "",
        team.location ? `Ville: ${team.location}` : "",
      ].filter(Boolean).join("\n");

      // Récupère les stats de la saison
      const teamData = await espnFetch(`${ESPN_BASE}/${slug}/teams/${team.id}`);
      const record = teamData?.team?.record?.items?.[0];
      const stats  = record?.stats ?? [];
      const get    = (n: string) => stats.find((s: any) => s.name === n)?.value ?? "?";
      const statsStr = `Saison: ${get("wins")}V-${get("ties")}N-${get("losses")}D`;

      return `${info}\n${statsStr}`;
    }
    await sleep(100);
  }
  return `Équipe "${teamName}" non trouvée dans les principales ligues.`;
}

/** Recherche joueur ESPN */
async function toolEspnPlayer(playerName: string): Promise<string> {
  const data = await safeFetch(
    `https://site.web.api.espn.com/apis/common/v3/sports/soccer/athletes?limit=5&search=${encodeURIComponent(playerName)}`
  );
  const athletes: any[] = data?.athletes ?? [];
  if (!athletes.length) return `Joueur "${playerName}" non trouvé sur ESPN.`;

  const p     = athletes[0];
  const lines = [
    `=== ${p.displayName ?? p.fullName ?? playerName} ===`,
    p.position?.displayName ? `Poste: ${p.position.displayName}` : "",
    p.team?.displayName     ? `Club: ${p.team.displayName}`       : "",
    p.age                   ? `Âge: ${p.age} ans`                 : "",
    p.nationality           ? `Nationalité: ${p.nationality}`      : "",
    p.height                ? `Taille: ${p.height}`               : "",
    p.weight                ? `Poids: ${p.weight}`                : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Stats détaillées d'un match ESPN (pour H2H ou analyse) */
async function toolEspnMatchDetails(homeTeam: string, awayTeam: string): Promise<string> {
  // Cherche l'event du jour correspondant
  const data = await espnFetch(`${ESPN_BASE}/all/scoreboard?dates=${todayESPN()}`);
  const events: any[] = data?.events ?? [];

  const match = events.find((ev: any) => {
    const name = (ev.name ?? ev.shortName ?? "").toLowerCase();
    return name.includes(homeTeam.toLowerCase()) || name.includes(awayTeam.toLowerCase());
  });

  if (!match) return `Match ${homeTeam} vs ${awayTeam} non trouvé sur ESPN aujourd'hui.`;

  const summary = await espnFetch(`${ESPN_BASE}/all/summary?event=${match.id}`);
  if (!summary) return "Détails du match non disponibles.";

  const lastFive: any[] = summary.lastFiveGames ?? [];
  const h2h    : any[] = summary.headToHeadGames ?? [];

  const lines = [`=== ${match.name} ===`];

  for (const team of lastFive.slice(0, 2)) {
    const teamName = team.team?.displayName ?? "?";
    const events5  = (team.events ?? []).slice(0, 5).map((ev: any) => {
      const comp = ev.competitions?.[0] ?? ev;
      const me   = comp?.competitors?.find((c: any) => c.team?.id === team.team?.id);
      const opp  = comp?.competitors?.find((c: any) => c.team?.id !== team.team?.id);
      if (!me || !opp) return "?";
      const ms = parseInt(me.score ?? "0", 10);
      const os = parseInt(opp.score ?? "0", 10);
      return ms > os ? `V(${ms}-${os})` : ms === os ? `N(${ms}-${os})` : `D(${ms}-${os})`;
    });
    lines.push(`${teamName} forme récente: ${events5.join(" ")}`);
  }

  const h2hSummary = h2h.slice(0, 5).map((ev: any) => {
    const comp = ev.competitions?.[0] ?? ev;
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
    if (!home || !away) return "";
    return `${home.team?.displayName ?? "?"} ${home.score ?? 0}-${away.score ?? 0} ${away.team?.displayName ?? "?"}`;
  }).filter(Boolean);

  if (h2hSummary.length) {
    lines.push(`\nH2H récents:`);
    lines.push(...h2hSummary);
  }

  return lines.join("\n").slice(0, 2000);
}

// ══════════════════════════════════════════════════════
//  DÉFINITIONS OUTILS GROQ (OpenAI Function Calling)
// ══════════════════════════════════════════════════════
const GROQ_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Recherche sur le web des infos football actuelles : transferts, résultats récents, mercato, classements, records, règles, actualités. Utilise cet outil si tu as besoin de données récentes ou si tu n'es pas sûr d'une information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Requête de recherche (ex: 'meilleur buteur Premier League 2025', 'transfert Mbappé')" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_standings",
      description: "Classement officiel d'une ligue de football via ESPN. Utilise pour: 'classement Premier League', 'tableau Ligue 1', etc.",
      parameters: {
        type: "object",
        properties: {
          league: { type: "string", description: "Slug ESPN de la ligue. Options: eng.1 (Premier League), esp.1 (La Liga), fra.1 (Ligue 1), ger.1 (Bundesliga), ita.1 (Serie A), uefa.champions (UCL), uefa.europa (Europa League), caf.nations (CAN), fifa.world (CM)" }
        },
        required: ["league"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_live_scores",
      description: "Scores des matchs en direct en ce moment dans les principales ligues européennes.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_schedule",
      description: "Programme des matchs du jour (ou en cours) dans les ligues de football.",
      parameters: {
        type: "object",
        properties: {
          league: { type: "string", description: "Optionnel: slug ESPN pour filtrer une ligue spécifique. Laisser vide pour toutes les ligues." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_news",
      description: "Dernières actualités football ESPN : news récentes, résultats importants.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_team",
      description: "Informations sur une équipe de football : stade, ville, bilan saison.",
      parameters: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Nom de l'équipe (ex: 'PSG', 'Arsenal', 'Real Madrid')" }
        },
        required: ["team_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_player",
      description: "Profil d'un joueur de football : poste, club, âge, nationalité.",
      parameters: {
        type: "object",
        properties: {
          player_name: { type: "string", description: "Nom du joueur (ex: 'Mbappé', 'Bellingham', 'Haaland')" }
        },
        required: ["player_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "espn_match_details",
      description: "Détails d'un match spécifique : forme récente des deux équipes, historique H2H. Utile pour analyser un match particulier.",
      parameters: {
        type: "object",
        properties: {
          home_team: { type: "string", description: "Nom de l'équipe à domicile" },
          away_team: { type: "string", description: "Nom de l'équipe à l'extérieur" }
        },
        required: ["home_team", "away_team"]
      }
    }
  }
];

// ══════════════════════════════════════════════════════
//  EXÉCUTEUR D'OUTILS
// ══════════════════════════════════════════════════════
async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "web_search":        return await toolWebSearch(args.query ?? "");
      case "espn_standings":    return await toolEspnStandings(args.league ?? "fra.1");
      case "espn_live_scores":  return await toolEspnLiveScores();
      case "espn_schedule":     return await toolEspnSchedule(args.league);
      case "espn_news":         return await toolEspnNews();
      case "espn_team":         return await toolEspnTeam(args.team_name ?? "");
      case "espn_player":       return await toolEspnPlayer(args.player_name ?? "");
      case "espn_match_details":return await toolEspnMatchDetails(args.home_team ?? "", args.away_team ?? "");
      default: return `Outil inconnu: ${name}`;
    }
  } catch (e) {
    return `Erreur lors de l'appel à l'outil ${name}: ${e}`;
  }
}

// ══════════════════════════════════════════════════════
//  AGENT GROQ — BOUCLE TOOL CALLING
// ══════════════════════════════════════════════════════

async function groqAgentLoop(chatId: number, userMessage: string): Promise<void> {
  keepTyping(chatId, 60_000);

  const messages: any[] = [
    {
      role: "system",
      content: `Tu es FootBot ⚽, un assistant football expert qui répond UNIQUEMENT en français.
Tu as accès à des outils pour récupérer des données réelles et actuelles du football.

RÈGLES:
- Utilise les outils ESPN pour les données structurées (classements, scores, équipes, joueurs)
- Utilise web_search pour les transferts, mercato, news, records, infos récentes
- Tu peux appeler plusieurs outils en parallèle si nécessaire
- Réponds de façon concise (max 300 mots) et bien formatée pour Telegram (HTML: <b>texte</b> pour gras, <i>texte</i> pour italique)
- Utilise des emojis pertinents pour rendre la réponse vivante
- Si tu n'es pas sûr d'une info, dis-le et cherche
- Pour les pronostics/paris, utilise le pipeline dédié (l'utilisateur doit demander explicitement)`,
    },
    { role: "user", content: userMessage },
  ];

  const MAX_ITERATIONS = 4;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: Response;
    try {
      resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model       : GROQ_MODEL,
          messages,
          tools       : GROQ_TOOLS,
          tool_choice : "auto",
          max_tokens  : 800,
          temperature : 0.4,
        }),
      });
    } catch {
      await send(chatId, "❌ Erreur de connexion à l'IA. Réessaie dans un instant !");
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[GROQ ERROR]", resp.status, errText);
      // Fallback sur le modèle rapide si quota dépassé
      if (resp.status === 429 || resp.status === 503) {
        await send(chatId, "⏳ Groq est surchargé en ce moment. Réessaie dans quelques secondes !");
      } else {
        await send(chatId, "❌ Erreur IA. Réessaie !");
      }
      return;
    }

    const data: any = await resp.json();
    const choice     = data.choices?.[0];
    if (!choice) { await send(chatId, "❌ Réponse IA vide."); return; }

    const finishReason = choice.finish_reason;
    const message      = choice.message;

    // ── Réponse finale ───────────────────────────────
    if (finishReason === "stop" || finishReason === "length") {
      const answer = message?.content?.trim();
      if (answer) await send(chatId, answer);
      else await send(chatId, "⚽ Je n'ai pas pu formuler une réponse. Reformule ta question !");
      return;
    }

    // ── Tool calls ───────────────────────────────────
    if (finishReason === "tool_calls") {
      const toolCalls: any[] = message?.tool_calls ?? [];
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });

      // Exécute tous les outils en parallèle
      await Promise.all(toolCalls.map(async (call: any) => {
        const toolName = call.function?.name ?? "";
        let argsObj: Record<string, any> = {};
        try { argsObj = JSON.parse(call.function?.arguments ?? "{}"); } catch { /* keep empty */ }

        console.log(`[TOOL] ${toolName}`, JSON.stringify(argsObj));
        const result = await executeTool(toolName, argsObj);

        messages.push({
          role        : "tool",
          tool_call_id: call.id,
          content     : result,
        });
      }));

      continue; // prochaine itération avec les résultats d'outils
    }

    // Fin inattendue
    await send(chatId, message?.content?.trim() ?? "⚽ Pas de réponse. Réessaie !");
    return;
  }

  await send(chatId, "⚽ J'ai cherché mais je n'ai pas trouvé de réponse claire. Reformule ta question !");
}

// ══════════════════════════════════════════════════════
//  PIPELINE PRONOSTICS (ESPN stats complètes + IA)
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
    const me   = comp?.competitors?.find((c: any) => c.team?.id === teamId);
    const opp  = comp?.competitors?.find((c: any) => c.team?.id !== teamId);
    if (!me || !opp) continue;
    const ms = parseInt(me.score ?? "0", 10) || 0;
    const os = parseInt(opp.score ?? "0", 10) || 0;
    scored5 += ms; conceded5 += os;
    if (ms + os > 2.5) over25Count++;
    if (ms > 0 && os > 0) bttsCount++;
    if (os === 0) cleanSheets++;
    if (ms === 0) failedScore++;
    if (me.winner === true || ms > os) { wins5++;  formArr.push("V"); }
    else if (ms === os)                { draws5++; formArr.push("N"); }
    else                               { losses5++;formArr.push("D"); }
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
    if (hs > as_) { home.team?.id === homeId ? homeWins++ : awayWins++; }
    else if (as_ > hs) { away.team?.id === homeId ? homeWins++ : awayWins++; }
    else draws++;
    if (hs + as_ > 2.5) over25++;
    if (hs > 0 && as_ > 0) btts++;
  }
  return {
    totalMatches: total,
    homeWinPct  : total ? Math.round((homeWins / total) * 100) : 50,
    awayWinPct  : total ? Math.round((awayWins / total) * 100) : 50,
    drawPct     : total ? Math.round((draws / total) * 100) : 25,
    over25H2H   : over25,
    bttsH2H     : btts,
  };
}

async function scrapeMatchESPN(event: any): Promise<MatchData | null> {
  try {
    const comp  = event.competitions?.[0];
    const homeC = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const awayC = comp?.competitors?.find((c: any) => c.homeAway === "away");
    if (!homeC || !awayC) return null;
    const homeTeam = homeC.team?.displayName ?? "?";
    const awayTeam = awayC.team?.displayName ?? "?";
    const homeId   = homeC.team?.id ?? "";
    const awayId   = awayC.team?.id ?? "";
    const league   = event.league?.name ?? comp?.notes?.[0]?.headline ?? "Football";
    const kickoff  = comp?.startDate ? fmtTime(comp.startDate) : "?";
    const summary  = await espnFetch(`${ESPN_BASE}/all/summary?event=${event.id}`);
    if (!summary) return null;
    await sleep(300);
    const lastFive: any[] = summary.lastFiveGames ?? [];
    const h2hData : any[] = summary.headToHeadGames ?? [];
    const oddsArr : any[] = summary.pickcenter ?? summary.odds ?? [];
    const homeStats = extractFormESPN(lastFive.find((t: any) => t.team?.id === homeId)?.events ?? [], homeId);
    const awayStats = extractFormESPN(lastFive.find((t: any) => t.team?.id === awayId)?.events ?? [], awayId);
    if (homeStats.wins5 + homeStats.draws5 + homeStats.losses5 < 1 &&
        awayStats.wins5 + awayStats.draws5 + awayStats.losses5 < 1) return null;
    const h2h       = extractH2HESPN(h2hData, homeId);
    const odds      = oddsArr[0];
    return {
      id: event.id, homeTeam, awayTeam, homeId, awayId, league, kickoff,
      homeStats, awayStats, h2h,
      overUnder: odds?.overUnder ?? 2.5,
      homeML   : odds?.homeTeamOdds?.moneyLine ?? 0,
      awayML   : odds?.awayTeamOdds?.moneyLine ?? 0,
    };
  } catch (e) { console.error("[SCRAPE]", e); return null; }
}

async function scrapeUpcomingMatches(count: number, onProgress: (m: string) => Promise<void>): Promise<MatchData[]> {
  const data = await espnFetch(`${ESPN_BASE}/all/scoreboard?dates=${todayESPN()}`);
  const candidates = (data?.events ?? []).filter((e: any) => e.competitions?.[0]?.status?.type?.state === "pre");
  const results: MatchData[] = [];
  for (const event of candidates) {
    if (results.length >= count) break;
    await onProgress(`🔍 ${results.length + 1}/${count} — <b>${event.name ?? "..."}</b>`);
    const m = await scrapeMatchESPN(event);
    if (m) results.push(m);
  }
  return results;
}

function computeSignals(m: MatchData): Record<string, number> {
  const h = m.homeStats, a = m.awayStats, x = m.h2h;
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
  const over25total = (h.over25Count + a.over25Count) / Math.max(h.wins5+h.draws5+h.losses5+a.wins5+a.draws5+a.losses5, 1);
  const overOULine  = m.overUnder <= 2.0 ? 10 : m.overUnder >= 3.0 ? -10 : 0;
  const over25 = Math.round(over25total * 80 + (x.over25H2H / Math.max(x.totalMatches, 1)) * 20 + overOULine);
  const homeSR = 1 - h.failedScore / Math.max(h.wins5+h.draws5+h.losses5, 1);
  const awaySR = 1 - a.failedScore / Math.max(a.wins5+a.draws5+a.losses5, 1);
  const homeCR = 1 - h.cleanSheets / Math.max(h.wins5+h.draws5+h.losses5, 1);
  const awayCR = 1 - a.cleanSheets / Math.max(a.wins5+a.draws5+a.losses5, 1);
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
  const h = m.homeStats, a = m.awayStats, x = m.h2h, sig = computeSignals(m);
  return [
    `MATCH: ${m.homeTeam} vs ${m.awayTeam} [${m.league}] ${m.kickoff}`,
    `HOME: forme=${h.form5} V${h.wins5}N${h.draws5}D${h.losses5} +${h.avgScored}/-${h.avgConceded} Over25:${h.over25Count} BTTS:${h.bttsCount} CS:${h.cleanSheets}`,
    `AWAY: forme=${a.form5} V${a.wins5}N${a.draws5}D${a.losses5} +${a.avgScored}/-${a.avgConceded} Over25:${a.over25Count} BTTS:${a.bttsCount} CS:${a.cleanSheets}`,
    `H2H: ${x.totalMatches}M homeWin=${x.homeWinPct}% draw=${x.drawPct}% awayWin=${x.awayWinPct}% Over25:${x.over25H2H} BTTS:${x.bttsH2H}`,
    `ODDS: homeML=${m.homeML} awayML=${m.awayML} OU=${m.overUnder}`,
    `SIG: homeWin=${sig.homeWin} awayWin=${sig.awayWin} draw=${sig.draw} o25=${sig.over25} u25=${sig.under25} btts=${sig.btts} noBtts=${sig.noBtts}`,
  ].join("\n");
}

function localFallback(m: MatchData): { market: string; choice: string; confidence: number; reason: string } {
  const sig = computeSignals(m);
  const candidates = [
    { market: "1X2",                        choice: `Victoire ${m.homeTeam}`, confidence: sig.homeWin, key: "homeWin" },
    { market: "1X2",                        choice: `Victoire ${m.awayTeam}`, confidence: sig.awayWin, key: "awayWin" },
    { market: "1X2",                        choice: "Match nul",              confidence: sig.draw,    key: "draw" },
    { market: "Plus/Moins buts",            choice: "Plus de 2.5 buts",       confidence: sig.over25,  key: "over25" },
    { market: "Plus/Moins buts",            choice: "Moins de 2.5 buts",      confidence: sig.under25, key: "under25" },
    { market: "Les deux équipes marquent",  choice: "Oui",                    confidence: sig.btts,    key: "btts" },
    { market: "Les deux équipes marquent",  choice: "Non",                    confidence: sig.noBtts,  key: "noBtts" },
  ];
  const best = candidates.reduce((a, b) => a.confidence >= b.confidence ? a : b);
  const h = m.homeStats, a_ = m.awayStats, x = m.h2h;
  const reasons: Record<string, string> = {
    homeWin : `${m.homeTeam} forme ${h.form5}, ${h.wins5}V/5`, awayWin: `${m.awayTeam} forme ${a_.form5}, ${a_.wins5}V/5`,
    draw    : `H2H ${x.drawPct}% nuls`,                        over25 : `Moy. buts ${h.avgScored}+${a_.avgScored}`,
    under25 : `CS dom.${h.cleanSheets}/5 ext.${a_.cleanSheets}/5`, btts: `BTTS ${(h.bttsCount+a_.bttsCount)/2}/5`,
    noBtts  : `CS fréquents ${h.cleanSheets}+${a_.cleanSheets}`,
  };
  return { ...best, reason: reasons[best.key] ?? "" };
}

async function analyseWithAI(m: MatchData): Promise<{ market: string; choice: string; confidence: number; reason: string }> {
  if (!GROQ_KEY) return localFallback(m);
  const prompt = `Analyste football expert. Stats du match:\n${buildStatsBlock(m)}\n\nRetourne UNIQUEMENT ce JSON:\n{"market":"Plus/Moins buts","choice":"Plus de 2.5 buts","confidence":72,"reason":"Over25 7/10, moy. 3.1 buts"}\n\nMarché le plus fiable. Confiance 51-89. JSON uniquement.`;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GROQ_FAST, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 150 }),
    });
    if (!r.ok) return localFallback(m);
    const data: any = await r.json();
    const raw    = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] ?? "{}");
    if (!parsed.market || !parsed.choice || !parsed.confidence) return localFallback(m);
    return parsed;
  } catch { return localFallback(m); }
}

function confBar(pct: number): string {
  const f = Math.round(pct / 10);
  return "🟩".repeat(f) + "⬜".repeat(10 - f) + ` ${pct}%`;
}

async function runPipeline(chatId: number, count: number): Promise<void> {
  const n = Math.max(1, Math.min(10, count));
  keepTyping(chatId, 120_000);
  const matches = await scrapeUpcomingMatches(n, async (msg) => { await send(chatId, msg); });
  if (!matches.length) {
    await send(chatId, "😕 Aucun match à venir trouvé aujourd'hui. Tape <b>programme</b> pour voir les matchs disponibles.");
    return;
  }
  await send(chatId, `🧠 Analyse IA en cours pour <b>${matches.length} match(s)</b>...`);
  const pronos: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], res = await analyseWithAI(m);
    pronos.push(
      `${i+1}. ⚽ <b>${m.homeTeam} vs ${m.awayTeam}</b>\n` +
      `👉 ${res.market} → <b>${res.choice}</b>\n` +
      confBar(res.confidence) + "\n" +
      `📊 ${res.reason}`
    );
  }
  await send(chatId,
    `⚽ <b>PRONOSTICS DU JOUR — ${matches.length} match(s)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    pronos.join("\n\n") +
    `\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>Analyse ESPN + IA. Jouer responsable.</i>`
  );
}

// ══════════════════════════════════════════════════════
//  HANDLE — ROUTEUR PRINCIPAL
// ══════════════════════════════════════════════════════

const GREETING = /^(bonjour|bonsoir|salut|hello|hi|hey|cc|coucou|yo|wesh|salam|bjr|bj|slt|ola|hola|gm|good\s?morning|bonne\s?nuit|bonne\s?journée|soir|jour|matin)[\s!.,?]*$/i;

const GREET_REPLIES = [
  "👋 Salut ! Je suis <b>FootBot ⚽</b>, ton assistant football IA.\n\nPose-moi <b>n'importe quelle question football</b> en langage naturel :\n\n• <i>\"Classement Premier League ?\"</i>\n• <i>\"Scores live ce soir\"</i>\n• <i>\"Stats de Mbappé\"</i>\n• <i>\"Transferts du mercato\"</i>\n• <i>\"Donne-moi 5 pronostics\"</i>\n• <i>\"Qui est le meilleur buteur de l'histoire ?\"</i>\n\nJe cherche les données réelles et je te réponds 🔥",
  "⚽ Hey ! Prêt à parler foot ?\n\nJe peux répondre à <b>tout</b> : scores live, classements, actu, transferts, joueurs, équipes, règles, histoire... Pose ta question !",
  "🔥 Salut ! Je suis FootBot, ton expert football IA.\n\nEnvoie ta question, je cherche les vraies données et je te réponds directement !",
];

function extractNumber(text: string): number | null {
  const m = text.match(/\b([1-9]|10)\b/);
  return m ? parseInt(m[1], 10) : null;
}

// Détection rapide des pronostics/paris (termes clairement liés aux paris sportifs)
// "analyse" seul est trop large — on ne le met pas pour éviter "analyse Ligue 1" → pipeline pronostics
const PRONOS_REGEX = /\b(prono|pronostic|pari\s+sportif|predic|tip\s+du\s+jour|bet|coup\s?sûr|mise|cote\s+du\s+jour)\b/i;

async function handle(chatId: number, raw: string): Promise<void> {
  const lower = raw.toLowerCase().trim();
  const phase = await loadPhase(chatId);

  // ── Chiffre en attente de confirmation ───────────
  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    if (num !== null) {
      await savePhase(chatId, "idle");
      await runPipeline(chatId, num);
      return;
    }
    await savePhase(chatId, "idle");
  }

  // ── Salutation rapide (sans Groq) ────────────────
  if (GREETING.test(lower)) {
    await send(chatId, GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)]);
    return;
  }

  // ── Commandes slash de base ──────────────────────
  if (lower.startsWith("/start") || lower.startsWith("/help") || lower === "/") {
    await send(chatId, GREET_REPLIES[0]);
    return;
  }

  // ── Pronostics avec nombre (bypass Groq) ─────────
  if (PRONOS_REGEX.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) {
      await runPipeline(chatId, num);
    } else {
      await savePhase(chatId, "awaiting_count");
      await send(chatId, "⚽ Combien de matchs tu veux que j'analyse ? (1 à 10)");
    }
    return;
  }

  // ── Chiffre seul = pronostics ─────────────────────
  if (/^\d+$/.test(lower.trim())) {
    const num = extractNumber(raw);
    if (num !== null) {
      await runPipeline(chatId, num);
      return;
    }
  }

  // ── Tout le reste → Agent Groq avec outils ───────
  await groqAgentLoop(chatId, raw);
}

// ══════════════════════════════════════════════════════
//  WEBHOOK
// ══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("FootBot v7 ⚽ Agent IA avec Tool Calling — ESPN + DuckDuckGo + Groq");
  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
