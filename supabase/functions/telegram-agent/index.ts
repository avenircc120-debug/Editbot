// ═══════════════════════════════════════════════════════
//  FOOTBOT — Moteur de Pronostics Sportifs IA
//  SofaScore (unofficial) + Groq AI · Mémoire persistante
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY  = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── SofaScore headers ─────────────────────────────────

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

// ── SofaScore fetch ───────────────────────────────────

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
  new Date(ts * 1000).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" });

// ══════════════════════════════════════════════════════
//  SESSION — Mémoire persistante (Supabase DB)
// ══════════════════════════════════════════════════════

type SessionPhase = "idle" | "predicting" | "awaiting_market";
interface Message  { role: "user" | "assistant"; content: string; }

interface Session {
  chatId     : number;
  phase      : SessionPhase;
  history    : Message[];
  memory     : string;        // Faits mémorisés long-terme (équipes favorites, style de jeu, etc.)
  lastMatch  ?: string;
  lastContext?: string;
}

// Cache local pour éviter des aller-retours DB inutiles dans la même requête
const cache = new Map<number, Session>();

function sbHeaders(): Record<string, string> {
  return {
    "apikey"       : SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Content-Type" : "application/json",
    "Prefer"       : "return=representation",
  };
}

async function loadSession(chatId: number): Promise<Session> {
  if (cache.has(chatId)) return cache.get(chatId)!;

  const blank: Session = { chatId, phase: "idle", history: [], memory: "" };

  if (!SB_URL || !SB_KEY) {
    cache.set(chatId, blank);
    return blank;
  }

  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=*`,
      { headers: sbHeaders() }
    );
    if (!r.ok) {
      console.error(`loadSession: DB returned ${r.status}`, await r.text().catch(() => ""));
      cache.set(chatId, blank);
      return blank;
    }
    const rows: any[] = await r.json();
    if (rows?.length) {
      const row = rows[0];
      const s: Session = {
        chatId,
        phase      : row.phase ?? "idle",
        history    : Array.isArray(row.history) ? row.history : [],
        memory     : row.memory ?? "",
        lastMatch  : row.last_match  ?? undefined,
        lastContext: row.last_context ?? undefined,
      };
      cache.set(chatId, s);
      return s;
    }
  } catch (e) { console.error("loadSession:", e); }

  cache.set(chatId, blank);
  return blank;
}

async function saveSession(s: Session): Promise<void> {
  cache.set(s.chatId, s);
  if (!SB_URL || !SB_KEY) return;

  try {
    const r = await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method : "POST",
      headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
      body   : JSON.stringify({
        chat_id     : s.chatId,
        phase       : s.phase,
        history     : s.history,
        memory      : s.memory,
        last_match  : s.lastMatch  ?? null,
        last_context: s.lastContext ?? null,
        updated_at  : new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      console.error(`saveSession: DB returned ${r.status}`, await r.text().catch(() => ""));
    }
  } catch (e) { console.error("saveSession:", e); }
}

function transition(s: Session, phase: SessionPhase) { s.phase = phase; }

function addHistory(s: Session, role: "user" | "assistant", content: string) {
  s.history.push({ role, content });
  if (s.history.length > 30) s.history = s.history.slice(-30);
}

// ══════════════════════════════════════════════════════
//  SYSTÈME DE PRÉDICTION IA — Format coupon strict
// ══════════════════════════════════════════════════════

// Ce prompt est la seule source de vérité pour le format de sortie.
// Il doit correspondre exactement à ce que runPrediction/runBulkPredictions attendent.
const PREDICTION_SYSTEM = `Tu es un moteur de pronostics sportifs. Ton rôle est de fournir des choix directs pour aider l'utilisateur à créer ses coupons.

RÈGLES DE FONCTIONNEMENT :
1. ANALYSE INTERNE : Pour chaque match, analyse les statistiques, la forme des équipes et les conditions actuelles en arrière-plan.
2. CHOIX DIRECT : Sur la base de ton analyse, sélectionne le marché le plus pertinent (1N2, Plus/Moins de buts, BTTS, Double Chance, Mi-temps, Score exact, etc.) et donne le choix final.
3. FORMAT OBLIGATOIRE — chaque ligne doit respecter ce modèle strict (rien d'autre) :
   N. [Équipe A] vs [Équipe B] 👉 Marché : [Type de marché] | Choix : [Ton pronostic]
4. ZÉRO DISCUSSION : Ne génère aucun texte d'introduction, aucun texte de conclusion, ne pose aucune question. Fournis uniquement la liste numérotée.
5. DÉFAUT : Si aucune compétition n'est précisée, utilise les données fournies pour les matchs majeurs du jour.
6. VARIÉTÉ : Varie les marchés selon ce qui est le plus solide pour chaque match. Ne mets pas tous les matchs sur 1N2.

Marchés disponibles : 1N2 · Double Chance · BTTS Oui/Non · Plus/Moins de 1.5 buts · Plus/Moins de 2.5 buts · Score exact · Résultat mi-temps · Mi-temps/Fin

Exemple de sortie valide :
1. Manchester City vs Liverpool 👉 Marché : 1N2 | Choix : 1
2. PSG vs Marseille 👉 Marché : Total Buts | Choix : Plus de 2.5
3. Real Madrid vs Atlético 👉 Marché : BTTS | Choix : Oui

Réponds UNIQUEMENT avec la liste numérotée. Rien avant, rien après.`;

// ── Récupération de N matchs majeurs du jour ──────────

interface MatchSlot {
  label  : string;
  context: string;
}

async function getDefaultMatches(max = 10): Promise<MatchSlot[]> {
  const slots: MatchSlot[] = [];

  const live    = await sfFetch("/sport/football/events/live");
  const liveEvs = live?.events?.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id)) ?? [];
  for (const e of liveEvs) {
    if (slots.length >= max) break;
    slots.push({
      label  : `${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`,
      context: `EN DIRECT: ${e.homeTeam?.name} ${e.homeScore?.current ?? 0}-${e.awayScore?.current ?? 0} ${e.awayTeam?.name} (${e.tournament?.name})`,
    });
  }

  if (slots.length < max) {
    const day    = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
    const dayEvs = day?.events
      ?.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id) && e.status?.type !== "finished")
      ?.sort((a: any, b: any) => a.startTimestamp - b.startTimestamp) ?? [];
    for (const e of dayEvs) {
      if (slots.length >= max) break;
      const label = `${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`;
      if (!slots.some(s => s.label === label)) {
        slots.push({
          label,
          context: `Match à ${fmtTime(e.startTimestamp)}: ${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`,
        });
      }
    }
  }
  return slots;
}

// ── Appels IA prédictifs ──────────────────────────────

async function runPrediction(matchInfo: string, dataCtx: string): Promise<string> {
  const userPrompt = dataCtx
    ? `Génère les pronostics pour ce match.\n\n=== DONNÉES TEMPS RÉEL ===\n${dataCtx}\n\nMatch : ${matchInfo}`
    : `Génère les pronostics pour ce match.\n\nMatch : ${matchInfo}`;

  const raw = await groq(
    [
      { role: "system", content: PREDICTION_SYSTEM },
      { role: "user"  , content: userPrompt },
    ],
    { temperature: 0.15, max_tokens: 500 }
  );

  return raw.trim() || "⚠️ Aucune donnée disponible pour ce match.";
}

async function runBulkPredictions(slots: MatchSlot[], market?: string): Promise<string> {
  if (!slots.length) return "❌ Aucun match majeur trouvé en ce moment.";

  const matchList = slots.map((s, i) => `${i + 1}. ${s.context}`).join("\n");
  const marketLine = market
    ? `Marchés demandés : ${market}`
    : "Varie les marchés selon ce qui est le plus solide pour chaque match.";

  const raw = await groq(
    [
      { role: "system", content: PREDICTION_SYSTEM },
      {
        role   : "user",
        content: `Génère des pronostics pour ces matchs des compétitions majeures.\n${marketLine}\n\n=== MATCHS ===\n${matchList}`,
      },
    ],
    { temperature: 0.15, max_tokens: 1500 }
  );

  return raw.trim() || "⚠️ Aucune prédiction générée. Réessayez dans quelques secondes.";
}

// ══════════════════════════════════════════════════════
//  DONNÉES FOOTBALL (SofaScore)
// ══════════════════════════════════════════════════════

async function getLive(): Promise<string> {
  const d = await sfFetch("/sport/football/events/live");
  if (!d?.events?.length) return "⚽ Aucun match en direct en ce moment.";
  const evs = d.events.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id)).slice(0, 20);
  if (!evs.length) return "⚽ Aucun match des ligues majeures en direct.";
  const lines = ["🔴 *MATCHS EN DIRECT*\n"];
  let last = "";
  for (const e of evs) {
    const lg = e.tournament?.name ?? "";
    if (lg !== last) { lines.push(`\n🏆 *${lg}*`); last = lg; }
    const period = e.time?.period ?? 1;
    const ps = e.time?.currentPeriodStartTimestamp ?? 0;
    const el = ps ? Math.floor((Date.now() / 1000 - ps) / 60) : 0;
    const min = ps ? `${Math.min((period === 2 ? 45 : 0) + el, 90)}'` : (e.status?.description ?? "");
    lines.push(`⏱ ${min} │ ${e.homeTeam?.name} *${e.homeScore?.current ?? 0}-${e.awayScore?.current ?? 0}* ${e.awayTeam?.name}`);
  }
  return lines.join("\n");
}

async function getToday(): Promise<string> {
  const d = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
  if (!d?.events?.length) return "📅 Aucun match programmé aujourd'hui.";
  const evs = d.events.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id));
  if (!evs.length) return "📅 Aucun match des ligues majeures aujourd'hui.";
  const lines = ["📅 *MATCHS DU JOUR*\n"];
  let last = "";
  for (const e of evs) {
    const lg = e.tournament?.name ?? "";
    if (lg !== last) { lines.push(`\n🏆 *${lg}*`); last = lg; }
    const h = e.homeTeam?.name ?? "?", a = e.awayTeam?.name ?? "?";
    const hs = e.homeScore?.current ?? 0, as_ = e.awayScore?.current ?? 0;
    const st = e.status?.type;
    lines.push(
      st === "inprogress" ? `🔴 ${h} *${hs}-${as_}* ${a}` :
      st === "finished"   ? `✅ ${h} ${hs}-${as_} ${a}` :
      `🕐 ${fmtTime(e.startTimestamp)} │ ${h} vs ${a}`
    );
  }
  return lines.join("\n");
}

async function getStandings(key: string): Promise<string> {
  const lg = LEAGUES[key.toLowerCase()];
  if (!lg) return `❌ Ligue inconnue. Disponibles: ${Object.keys(LEAGUES).join(", ")}`;
  const sd = await sfFetch(`/unique-tournament/${lg.id}/seasons`);
  const season = sd?.seasons?.[0];
  if (!season) return "❌ Saison non disponible.";
  const d = await sfFetch(`/unique-tournament/${lg.id}/season/${season.id}/standings/total`);
  const rows = d?.standings?.[0]?.rows;
  if (!rows?.length) return "❌ Classement non disponible.";
  const lines = [`🏆 *${lg.name} — Classement ${season.year ?? ""}*\n`];
  for (const r of rows.slice(0, 20)) {
    const gd = r.scoredGoals - r.receivedGoals;
    lines.push(`${String(r.position).padEnd(3)}${(r.team?.name ?? "?").substring(0, 20).padEnd(21)}${String(r.points).padEnd(4)}pts │ ${r.matches}J ${r.wins}V ${r.draws}N ${r.losses}D │ ${gd >= 0 ? "+" : ""}${gd}`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

async function sfSearch(q: string): Promise<any[]> {
  return (await sfFetch(`/search/all?q=${encodeURIComponent(q)}`))?.results ?? [];
}

async function getTeam(name: string): Promise<string> {
  const rs = await sfSearch(name);
  const hit = rs.find((r: any) => r.type === "team");
  const id = hit?.entity?.id ?? hit?.id;
  if (!id) return `❌ Équipe "${name}" non trouvée.`;
  const [info, last] = await Promise.all([sfFetch(`/team/${id}`), sfFetch(`/team/${id}/events/last/0`)]);
  const t = info?.team;
  const lines = [
    `⚽ *${t?.name ?? name}*`,
    t?.country?.name ? `🌍 ${t.country.name}` : "",
    t?.manager?.name ? `👔 Entraîneur: ${t.manager.name}` : "",
    t?.venue?.name   ? `🏟 Stade: ${t.venue.name}${t.venue.capacity ? ` (${t.venue.capacity.toLocaleString()} places)` : ""}` : "",
    "", "📊 *5 derniers matchs:*",
  ].filter(Boolean);
  const evs: any[] = last?.events?.slice(-5) ?? [];
  const forme: string[] = [];
  for (const e of evs) {
    const hs = e.homeScore?.current ?? 0, as_ = e.awayScore?.current ?? 0;
    const iH = e.homeTeam?.id === id, w = iH ? hs > as_ : as_ > hs, dr = hs === as_;
    lines.push(`${dr ? "🤝" : w ? "✅" : "❌"} ${e.homeTeam?.name} ${hs}-${as_} ${e.awayTeam?.name}`);
    forme.push(dr ? "N" : w ? "V" : "D");
  }
  if (forme.length) lines.push(`\n🔥 Forme: ${forme.join("-")}`);
  return lines.join("\n");
}

async function getPlayer(name: string): Promise<string> {
  const rs = await sfSearch(name);
  const hit = rs.find((r: any) => r.type === "player");
  const id = hit?.entity?.id ?? hit?.id;
  if (!id) return `❌ Joueur "${name}" non trouvé.`;
  const [info, stats] = await Promise.all([sfFetch(`/player/${id}`), sfFetch(`/player/${id}/statistics/season`)]);
  const p = info?.player, s = stats?.seasons?.[0]?.statistics;
  const age = p?.dateOfBirthTimestamp ? Math.floor((Date.now() / 1000 - p.dateOfBirthTimestamp) / (365.25 * 86400)) : null;
  const lines = [
    `👤 *${p?.name ?? name}*`,
    p?.team?.name    ? `⚽ Club: ${p.team.name}`           : "",
    p?.country?.name ? `🌍 Nationalité: ${p.country.name}` : "",
    p?.position      ? `📍 Poste: ${p.position}`           : "",
    p?.height        ? `📏 Taille: ${p.height} cm`         : "",
    age !== null     ? `🎂 Âge: ${age} ans`                : "",
    p?.preferredFoot ? `🦶 Pied: ${p.preferredFoot}`       : "",
  ].filter(Boolean);
  if (s) {
    lines.push("", "📊 *Stats saison:*");
    if (s.goals !== undefined)         lines.push(`⚽ Buts: ${s.goals}`);
    if (s.assists !== undefined)       lines.push(`🎯 Passes D: ${s.assists}`);
    if (s.appearances !== undefined)   lines.push(`🏟 Matchs: ${s.appearances}`);
    if (s.minutesPlayed !== undefined) lines.push(`⏱ Minutes: ${s.minutesPlayed}`);
    if (s.rating !== undefined)        lines.push(`⭐ Note: ${Number(s.rating).toFixed(2)}`);
    if (s.yellowCards !== undefined)   lines.push(`🟨 Jaunes: ${s.yellowCards}`);
    if (s.redCards !== undefined)      lines.push(`🟥 Rouges: ${s.redCards}`);
  }
  return lines.join("\n");
}

async function getH2H(n1: string, n2: string): Promise<string> {
  const [r1, r2] = await Promise.all([sfSearch(n1), sfSearch(n2)]);
  const t1 = r1.find((r: any) => r.type === "team"), t2 = r2.find((r: any) => r.type === "team");
  const id1 = t1?.entity?.id ?? t1?.id, id2 = t2?.entity?.id ?? t2?.id;
  const nm1 = t1?.entity?.name ?? t1?.name ?? n1, nm2 = t2?.entity?.name ?? t2?.name ?? n2;
  if (!id1 || !id2) return "❌ Une ou plusieurs équipes non trouvées.";
  const d = await sfFetch(`/team/${id1}/team/${id2}/h2h`);
  const evs: any[] = d?.teamDuel?.events ?? [];
  if (!evs.length) return `❌ Aucun historique entre ${nm1} et ${nm2}.`;
  let w1 = 0, w2 = 0, draws = 0;
  const lines = [`⚔️ *${nm1} vs ${nm2} — H2H*\n`];
  for (const e of evs.slice(0, 10)) {
    const hs = e.homeScore?.current ?? 0, as_ = e.awayScore?.current ?? 0;
    const s1 = e.homeTeam?.id === id1 ? hs : as_, s2 = e.homeTeam?.id === id1 ? as_ : hs;
    lines.push(`${s1 > s2 ? "🟢" : s1 < s2 ? "🔴" : "⚪"} ${fmtDate(e.startTimestamp)} │ ${e.homeTeam?.name} ${hs}-${as_} ${e.awayTeam?.name}`);
    if (hs === as_) draws++; else if (s1 > s2) w1++; else w2++;
  }
  lines.push(`\n📊 *Bilan:* 🟢 ${nm1}: ${w1}V │ ⚪ Nuls: ${draws} │ 🔴 ${nm2}: ${w2}V`);
  return lines.join("\n");
}

async function buildMatchContext(teamA: string, teamB: string): Promise<string> {
  const [t1, t2, hh] = await Promise.all([getTeam(teamA), getTeam(teamB), getH2H(teamA, teamB)]);
  return `${t1}\n\n${t2}\n\n${hh}`;
}

// ══════════════════════════════════════════════════════
//  GROQ AI
// ══════════════════════════════════════════════════════

const MODELS = ["llama-3.3-70b-versatile", "llama3-8b-8192", "gemma2-9b-it"];

interface GroqOptions { temperature?: number; max_tokens?: number; }

async function groq(
  msgs: { role: string; content: string }[],
  opts: GroqOptions = {}
): Promise<string> {
  const { temperature = 0.6, max_tokens = 1500 } = opts;
  for (const model of MODELS) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method : "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body   : JSON.stringify({ model, messages: msgs, temperature, max_tokens }),
      });
      if (!r.ok) continue;
      const d = await r.json(), c = d.choices?.[0]?.message?.content;
      if (c?.trim()) return c.trim();
    } catch { continue; }
  }
  return "";
}

// ── Mémoire : extraction de faits mémorisables ────────
// L'IA identifie les faits importants dans la conversation et les résume
async function extractMemory(newFact: string, existing: string): Promise<string> {
  const prompt = existing
    ? `Voici la mémoire actuelle de cet utilisateur :\n${existing}\n\nNouveau message utilisateur : "${newFact}"\n\nMets à jour la mémoire en intégrant les nouveaux éléments pertinents (équipes favorites, style de paris, préférences). Réponds uniquement avec la mémoire mise à jour (max 300 caractères, en français).`
    : `Extrait les informations utiles de ce message pour mémoriser les préférences de l'utilisateur : "${newFact}"\n\nRéponds uniquement avec les faits mémorisés (max 300 caractères, en français). Si aucun fait utile, réponds par une chaîne vide.`;

  return groq(
    [{ role: "system", content: "Tu es un système de mémorisation des préférences utilisateur. Tu extrais et résumes les informations pertinentes pour personnaliser les prochaines interactions." },
     { role: "user"  , content: prompt }],
    { temperature: 0.3, max_tokens: 100 }
  );
}

// ── Détection d'intention pronostic ───────────────────

const PRONO_INTENT_RE = /\b(pronostic|prono|paris?|mise|cote|côte|match|matchs|analyse|foot|football|soir|aujourd'?hui|ligue|ligue1|premier|laliga|bundesliga|seriea|ucl|gagnant|score|buts?|over|under|btts|1x2|pr[ée]vision|pr[ée]diction)\b/i;
const BULK_COUNT_RE   = /\b(\d{1,2})\s*(matchs?|pronostics?|pronos?|paris?)\b/i;

function detectPronosticIntent(text: string): { isBulk: boolean; count: number } | null {
  const bulk = text.match(BULK_COUNT_RE);
  if (bulk) return { isBulk: true, count: Math.min(parseInt(bulk[1], 10), 20) };
  if (PRONO_INTENT_RE.test(text)) return { isBulk: false, count: 5 };
  return null;
}

// ── Chat général ──────────────────────────────────────

async function aiChat(q: string, hist: Message[], memory: string): Promise<string> {
  const memoryBlock = memory
    ? `\nCe que tu sais de cet utilisateur :\n${memory}\n`
    : "";

  return groq(
    [
      {
        role   : "system",
        content: `Tu es FootBot, système expert d'analyse football IA.${memoryBlock}
RÈGLES ABSOLUES :
- Tu réponds TOUJOURS par une action ou une information concrète — JAMAIS par une question.
- Si la demande est vague, tu fournis immédiatement une réponse utile avec des défauts intelligents.
- Tes réponses sont courtes, directes et en français.
- Tu ne termines JAMAIS par une question.
- Si l'utilisateur te salue, réponds brièvement et donne le statut du moment (matchs en cours, prochain match majeur).
Commandes disponibles: /live /auj /classement /equipe /joueur /h2h /pronostic`,
      },
      ...hist.slice(-10),
      { role: "user", content: q },
    ],
    { temperature: 0.4 }
  );
}

// ══════════════════════════════════════════════════════
//  TELEGRAM HELPERS
// ══════════════════════════════════════════════════════

async function send(chatId: number, text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const c of chunks) {
    try {
      const r = await fetch(`${TG}/sendMessage`, {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({ chat_id: chatId, text: c, parse_mode: "Markdown" }),
      });
      if (!r.ok) {
        await fetch(`${TG}/sendMessage`, {
          method : "POST",
          headers: { "Content-Type": "application/json" },
          body   : JSON.stringify({ chat_id: chatId, text: c.replace(/[*_`\[\]]/g, "") }),
        });
      }
    } catch (e) {
      console.error("Telegram send error:", e);
    }
  }
}

const typing = (id: number) =>
  fetch(`${TG}/sendChatAction`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ chat_id: id, action: "typing" }),
  });

// ══════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════

async function handle(chatId: number, text: string) {
  const s   = await loadSession(chatId);
  const cmd = text.trim();
  typing(chatId);

  // ── Aide ──────────────────────────────────────────
  if (["/start", "/help", "/aide"].includes(cmd)) {
    transition(s, "idle");
    await saveSession(s);
    return send(chatId,
      `⚽ *FootBot — Moteur de Pronostics Sportifs IA*\n` +
      `_Groq AI · SofaScore · Mémoire persistante_\n\n` +
      `🎯 /pronostic — Pronostics directs (coupon prêt)\n` +
      `🎯 /pronostic PSG vs Real — Match précis\n` +
      `🔴 /live — Matchs en direct\n` +
      `📅 /auj — Matchs du jour\n` +
      `🏆 /classement [ligue] — Classement\n` +
      `⚽ /equipe [nom] — Infos équipe\n` +
      `👤 /joueur [nom] — Stats joueur\n` +
      `⚔️ /h2h [e1] vs [e2] — Historique\n` +
      `🧠 /memoire — Voir ma mémoire\n` +
      `🗑 /oublie — Effacer ma mémoire\n\n` +
      `*Ligues:* premier · laliga · ligue1 · bundesliga · seriea · ucl`
    );
  }

  // ── Afficher la mémoire ───────────────────────────
  if (cmd === "/memoire") {
    return send(chatId,
      s.memory
        ? `🧠 *Ce que je retiens de toi :*\n\n${s.memory}`
        : "🧠 Je n'ai encore rien mémorisé te concernant."
    );
  }

  // ── Effacer la mémoire ────────────────────────────
  if (cmd === "/oublie") {
    s.memory      = "";
    s.history     = [];
    s.phase       = "idle";
    s.lastMatch   = undefined;
    s.lastContext = undefined;
    await saveSession(s);
    return send(chatId, "🗑 Mémoire effacée. Je repars de zéro.");
  }

  // ── Live ──────────────────────────────────────────
  if (cmd === "/live") {
    transition(s, "idle");
    const r = await getLive();
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── Aujourd'hui ───────────────────────────────────
  if (cmd === "/auj" || cmd === "/aujourd'hui" || cmd === "/today") {
    transition(s, "idle");
    const r = await getToday();
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── Classement ────────────────────────────────────
  const cm = cmd.match(/^\/classement\s+(\w+)$/i);
  if (cm) {
    transition(s, "idle");
    const r = await getStandings(cm[1]);
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── Équipe ────────────────────────────────────────
  const em = cmd.match(/^\/equipe\s+(.+)$/i);
  if (em) {
    transition(s, "idle");
    const r = await getTeam(em[1].trim());
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── Joueur ────────────────────────────────────────
  const jm = cmd.match(/^\/joueur\s+(.+)$/i);
  if (jm) {
    transition(s, "idle");
    const r = await getPlayer(jm[1].trim());
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── H2H ──────────────────────────────────────────
  const hm = cmd.match(/^\/h2h\s+(.+)\s+vs\.?\s+(.+)$/i);
  if (hm) {
    transition(s, "idle");
    const r = await getH2H(hm[1].trim(), hm[2].trim());
    addHistory(s, "user", cmd); addHistory(s, "assistant", r);
    await saveSession(s); return send(chatId, r);
  }

  // ── Pronostic ─────────────────────────────────────
  const pm = cmd.match(/^\/pronostic(?:\s+(.+))?$/i);
  if (pm) {
    transition(s, "predicting");
    const arg = pm[1]?.trim() ?? "";

    // Scénario 1 — Match précis : /pronostic PSG vs Real Madrid
    const matchParts = arg.match(/^(.+)\s+vs\.?\s+(.+)$/i);
    if (matchParts) {
      const [, teamA, teamB] = matchParts;
      await send(chatId, `🔍 Collecte des données : *${teamA.trim()}* vs *${teamB.trim()}*...`);
      const dataCtx = await buildMatchContext(teamA.trim(), teamB.trim());
      s.lastMatch   = arg;
      s.lastContext = dataCtx;
      await send(chatId, "🧠 Analyse en cours...");
      const result = await runPrediction(arg, dataCtx);
      addHistory(s, "user", cmd);
      addHistory(s, "assistant", result);
      transition(s, "awaiting_market");
      await saveSession(s);
      return send(chatId, result);
    }

    // Scénario 2 — Vague ou en masse : /pronostic | /pronostic 10 matchs
    const bulkMatch = arg.match(BULK_COUNT_RE);
    const count     = bulkMatch ? Math.min(parseInt(bulkMatch[1], 10), 20) : 5;
    await send(chatId, `🔍 Collecte des ${count} meilleurs matchs du moment...`);
    const slots = await getDefaultMatches(count);
    if (!slots.length) {
      transition(s, "idle");
      await saveSession(s);
      return send(chatId, "❌ Aucun match majeur en ce moment. Précisez : `/pronostic Équipe1 vs Équipe2`");
    }
    await send(chatId, `🧠 Analyse de *${slots.length}* match(s)...`);
    const result = await runBulkPredictions(slots);
    addHistory(s, "user", cmd);
    addHistory(s, "assistant", result);
    s.lastMatch   = undefined;
    s.lastContext = undefined;
    transition(s, "idle");
    await saveSession(s);
    return send(chatId, result);
  }

  // ── Marché additionnel (état awaiting_market) ─────
  if (s.phase === "awaiting_market" && s.lastMatch &&
      /^(over|under|btts|score|double|1x2|r[ée]sultat|mi-temps|1n2)/i.test(cmd)) {
    transition(s, "predicting");
    await send(chatId, `🧠 Analyse du marché *${cmd}* sur ${s.lastMatch}...`);
    const extraCtx = `${s.lastContext ?? s.lastMatch}\n\nMarché demandé: ${cmd}`;
    const result   = await runPrediction(s.lastMatch, extraCtx);
    addHistory(s, "user", cmd);
    addHistory(s, "assistant", result);
    transition(s, "awaiting_market");
    await saveSession(s);
    return send(chatId, result);
  }

  // ── Texte libre — détection d'intention pronostic ─
  const intent = detectPronosticIntent(cmd);
  if (intent) {
    transition(s, "predicting");
    await send(chatId, `🔍 Collecte des meilleurs matchs du moment...`);
    const intentSlots = await getDefaultMatches(intent.count);
    if (intentSlots.length) {
      await send(chatId, `🧠 Analyse de *${intentSlots.length}* match(s)...`);
      const result = await runBulkPredictions(intentSlots);
      addHistory(s, "user", cmd);
      addHistory(s, "assistant", result);
      s.lastMatch   = undefined;
      s.lastContext = undefined;
      transition(s, "idle");
      await saveSession(s);
      return send(chatId, result);
    }
  }

  // ── Conversation générale ─────────────────────────
  // Mémoriser en arrière-plan si le message contient des préférences
  const MEMORY_TRIGGER = /\b(j'aime|je préfère|mon équipe|je mise|toujours|jamais|je veux|habituellement|je suis fan|ma ligue)\b/i;
  if (MEMORY_TRIGGER.test(cmd) && cmd.length > 10) {
    extractMemory(cmd, s.memory)
      .then(updated => { if (updated) { s.memory = updated.slice(0, 300); saveSession(s); } })
      .catch(() => {});
  }

  transition(s, "idle");
  addHistory(s, "user", cmd);
  const r    = await aiChat(cmd, s.history.slice(0, -1), s.memory);
  const resp = r || "⚽ Aucune donnée disponible. Essayez /live ou /auj.";
  addHistory(s, "assistant", resp);
  await saveSession(s);
  return send(chatId, resp);
}

// ══════════════════════════════════════════════════════
//  SERVEUR WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

if (!WEBHOOK_SECRET) {
  console.warn(
    "[SECURITY] TELEGRAM_WEBHOOK_SECRET non configuré — " +
    "toute requête POST est acceptée sans vérification d'origine."
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("FootBot ⚽ — Moteur de Pronostics Sportifs IA");

  if (WEBHOOK_SECRET) {
    const sig = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`Unauthorized webhook — IP: ${req.headers.get("x-forwarded-for") ?? "unknown"}`);
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const b = await req.json(), m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch { return new Response("OK"); }
});
