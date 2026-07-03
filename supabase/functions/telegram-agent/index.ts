// ═══════════════════════════════════════════════════════
//  FOOTBOT — Système d'Analyse Prédictive Sportive
//  SofaScore (unofficial) + Groq AI · Fiabilité cible 99%
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY  = Deno.env.get("GROQ_API_KEY") ?? "";
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

// IDs des ligues majeures (filtre SofaScore)
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
//  MACHINE À ÉTATS — Session utilisateur
// ══════════════════════════════════════════════════════

type SessionPhase =
  | "idle"              // En attente de commande
  | "predicting"        // Analyse en cours
  | "awaiting_market";  // Pronostic reçu, marché additionnel possible

interface Message { role: "user" | "assistant"; content: string; }

interface Session {
  phase      : SessionPhase;
  history    : Message[];
  lastMatch  ?: string;       // Dernier match analysé (pour relances)
  lastContext?: string;       // Contexte complet du dernier match
}

const sessions = new Map<number, Session>();

function getSession(id: number): Session {
  if (!sessions.has(id)) sessions.set(id, { phase: "idle", history: [] });
  return sessions.get(id)!;
}

function transition(s: Session, phase: SessionPhase) {
  s.phase = phase;
}

function addHistory(s: Session, role: "user" | "assistant", content: string) {
  s.history.push({ role, content });
  if (s.history.length > 20) s.history = s.history.slice(-20);
}

// ══════════════════════════════════════════════════════
//  SYSTÈME DE PRÉDICTION IA — Prompt strict
// ══════════════════════════════════════════════════════

const PREDICTION_SYSTEM = `Tu es un système d'analyse prédictive sportive. Ton objectif est de fournir des pronostics avec une fiabilité de 99%.

RÈGLES DE FONCTIONNEMENT (OBLIGATOIRES) :

1. AUTO-COMPLÉTION : Si l'utilisateur est vague (pas de match précis), tu appliques par défaut :
   - Compétition = Majeure du moment (celle fournie dans le contexte)
   - Marchés = Résultat 1X2 + BTTS + Total Buts
   - Tu NOTIFIES : "⚙️ Défaut appliqué : [compétition choisie], marchés mixtes"

2. FILTRE DE SÉCURITÉ ABSOLU : Tu analyses rigoureusement CHAQUE marché.
   Si la confiance d'un marché est < 90%, tu NE PRODUIS PAS ce marché dans ta sortie.
   Si AUCUN marché ne dépasse 90%, tu réponds UNIQUEMENT :
   "🚫 Signal trop faible — aucune prédiction fiable pour ce match."
   Tu n'ajoutes rien d'autre dans ce cas.

3. FORMAT DE SORTIE STRICT (un marché par ligne) :
   [Match] | [Marché] | [Pronostic] | [Confiance: XX%]
   
   Exemple valide :
   PSG vs Real Madrid | Résultat | PSG gagne (1) | Confiance: 93%
   PSG vs Real Madrid | BTTS | Oui | Confiance: 91%

4. AUTORITÉ TOTALE : Tu ne poses aucune question. Tu appliques les défauts et fournis le résultat immédiatement.

5. MARCHÉS DISPONIBLES : Résultat 1X2 · Double chance · BTTS · Over/Under 1.5 · Over/Under 2.5 · Score exact · Mi-temps/Fin

Réponds UNIQUEMENT avec les lignes de format ci-dessus ou le message d'erreur. Rien d'autre.`;

// ── Détection du match par défaut (compétition majeure du jour) ──

async function getDefaultMatch(): Promise<{ match: string; context: string } | null> {
  // 1. Matchs en direct d'abord
  const live = await sfFetch("/sport/football/events/live");
  const liveEvs = live?.events?.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id)) ?? [];
  if (liveEvs.length > 0) {
    const e = liveEvs[0];
    return {
      match  : `${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`,
      context: `Match en direct: ${e.homeTeam?.name} ${e.homeScore?.current ?? 0}-${e.awayScore?.current ?? 0} ${e.awayTeam?.name} (${e.tournament?.name})`,
    };
  }

  // 2. Prochain match du jour
  const day = await sfFetch(`/sport/football/scheduled-events/${todayStr()}`);
  const dayEvs = day?.events
    ?.filter((e: any) => MAJOR.has(e.tournament?.uniqueTournament?.id) && e.status?.type !== "finished")
    ?.sort((a: any, b: any) => a.startTimestamp - b.startTimestamp) ?? [];
  if (dayEvs.length > 0) {
    const e = dayEvs[0];
    return {
      match  : `${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`,
      context: `Match du jour à ${fmtTime(e.startTimestamp)}: ${e.homeTeam?.name} vs ${e.awayTeam?.name} (${e.tournament?.name})`,
    };
  }
  return null;
}

// ── Extraction et filtrage de la confiance ────────────
//
// Format attendu (strict) par ligne :
//   [Match] | [Marché] | [Pronostic] | [Confiance: XX%]
// Un token est valide seulement si :
//   • il respecte exactement la structure à 4 champs séparés par "|"
//   • le 4e champ contient "Confiance:" suivi d'un entier entre 0 et 100
//   • la confiance est ≥ 90 pour passer le filtre

interface PredLine {
  raw       : string;  // ligne originale
  confidence: number;  // valeur extraite (0-100)
}

// Regex ancrée : valide l'intégralité de la ligne, extrait la confiance
// uniquement depuis le dernier champ "Confiance: XX%"
const PRED_LINE_RE = /^[^|]+\|[^|]+\|[^|]+\|\s*confiance\s*:\s*(\d{1,3})\s*%\s*$/i;

function parsePredictions(raw: string): PredLine[] {
  const results: PredLine[] = [];
  for (const line of raw.split("\n").map(l => l.trim()).filter(Boolean)) {
    const m = line.match(PRED_LINE_RE);
    if (!m) continue;
    const conf = parseInt(m[1], 10);
    if (conf < 0 || conf > 100) continue;   // valeur hors-bornes → rejet
    results.push({ raw: line, confidence: conf });
  }
  return results;
}

function applyConfidenceFilter(raw: string): string {
  // L'IA a renvoyé le message d'erreur directement
  if (/signal trop faible/i.test(raw)) {
    return "🚫 *Signal trop faible* — aucune prédiction fiable pour ce match.";
  }

  const lines  = parsePredictions(raw);

  // Aucune ligne au format valide → bloquer par sécurité
  if (lines.length === 0) {
    return "🚫 *Signal trop faible* — aucune prédiction fiable pour ce match.";
  }

  const passed  = lines.filter(l => l.confidence >= 90);
  const blocked = lines.length - passed.length;

  if (passed.length === 0) {
    return "🚫 *Signal trop faible* — aucune prédiction fiable pour ce match.";
  }

  const header = "🎯 *PRONOSTICS CERTIFIÉS* _(confiance ≥ 90%)_\n";
  const body   = passed.map(l => `✅ ${l.raw}`).join("\n");
  const footer = blocked > 0
    ? `\n\n_${blocked} marché(s) filtré(s) — confiance insuffisante (<90%)_`
    : "";

  return `${header}\n${body}${footer}`;
}

// ── Appel IA prédictif ────────────────────────────────

async function runPrediction(matchInfo: string, dataCtx: string): Promise<string> {
  const userPrompt = dataCtx
    ? `Analyse ce match et génère les pronostics.\n\n=== DONNÉES TEMPS RÉEL ===\n${dataCtx}`
    : `Analyse ce match et génère les pronostics.\n\nMatch: ${matchInfo}`;

  const raw = await groq(
    [
      { role: "system", content: PREDICTION_SYSTEM },
      { role: "user"  , content: userPrompt },
    ],
    { temperature: 0.2, max_tokens: 800 } // Température basse = sorties plus déterministes
  );

  return applyConfidenceFilter(raw);
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
  const s = sd?.seasons?.[0];
  if (!s) return "❌ Saison non disponible.";
  const d = await sfFetch(`/unique-tournament/${lg.id}/season/${s.id}/standings/total`);
  const rows = d?.standings?.[0]?.rows;
  if (!rows?.length) return "❌ Classement non disponible.";
  const lines = [`🏆 *${lg.name} — Classement ${s.year ?? ""}*\n`];
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

// ── Construction du contexte match pour la prédiction ─

async function buildMatchContext(teamA: string, teamB: string): Promise<string> {
  const [t1, t2, hh] = await Promise.all([
    getTeam(teamA), getTeam(teamB), getH2H(teamA, teamB),
  ]);
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

async function aiChat(q: string, hist: Message[]): Promise<string> {
  return groq(
    [
      {
        role   : "system",
        content: `Tu es FootBot, expert analyste football IA. Tu maîtrises tous les championnats, équipes, joueurs, tactiques et statistiques. Réponds en français avec précision.
Commandes: /live, /auj, /classement [ligue], /equipe [nom], /joueur [nom], /h2h [e1] vs [e2], /pronostic [e1] vs [e2]
Ligues: premier · laliga · ligue1 · bundesliga · seriea · ucl`,
      },
      ...hist.slice(-10),
      { role: "user", content: q },
    ],
    { temperature: 0.5 }
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
        // Fallback sans Markdown (évite les erreurs de parsing)
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
  const s   = getSession(chatId);
  const cmd = text.trim();
  typing(chatId);

  // ── Aide ──────────────────────────────────────────
  if (["/start", "/help", "/aide"].includes(cmd)) {
    transition(s, "idle");
    return send(chatId,
      `⚽ *FootBot — Système d'Analyse Prédictive IA*\n` +
      `_Moteur Groq · Données SofaScore · Fiabilité cible 99%_\n\n` +
      `🔴 /live — Matchs en direct\n` +
      `📅 /auj — Matchs du jour\n` +
      `🏆 /classement [ligue] — Classement\n` +
      `⚽ /equipe [nom] — Infos équipe\n` +
      `👤 /joueur [nom] — Stats joueur\n` +
      `⚔️ /h2h [e1] vs [e2] — Historique\n` +
      `🎯 /pronostic [e1] vs [e2] — Prédiction IA certifiée\n\n` +
      `*Ligues:* premier · laliga · ligue1 · bundesliga · seriea · ucl\n\n` +
      `⚠️ _Seuls les pronostics avec confiance ≥ 90% sont affichés._`
    );
  }

  // ── Live ──────────────────────────────────────────
  if (cmd === "/live") {
    transition(s, "idle");
    const r = await getLive(); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── Aujourd'hui ───────────────────────────────────
  if (cmd === "/auj" || cmd === "/aujourd'hui" || cmd === "/today") {
    transition(s, "idle");
    const r = await getToday(); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── Classement ────────────────────────────────────
  const cm = cmd.match(/^\/classement\s+(\w+)$/i);
  if (cm) {
    transition(s, "idle");
    const r = await getStandings(cm[1]); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── Équipe ────────────────────────────────────────
  const em = cmd.match(/^\/equipe\s+(.+)$/i);
  if (em) {
    transition(s, "idle");
    const r = await getTeam(em[1].trim()); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── Joueur ────────────────────────────────────────
  const jm = cmd.match(/^\/joueur\s+(.+)$/i);
  if (jm) {
    transition(s, "idle");
    const r = await getPlayer(jm[1].trim()); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── H2H ──────────────────────────────────────────
  const hm = cmd.match(/^\/h2h\s+(.+)\s+vs\.?\s+(.+)$/i);
  if (hm) {
    transition(s, "idle");
    const r = await getH2H(hm[1].trim(), hm[2].trim()); addHistory(s, "user", cmd); addHistory(s, "assistant", r); return send(chatId, r);
  }

  // ── Pronostic ─────────────────────────────────────
  const pm = cmd.match(/^\/pronostic(?:\s+(.+))?$/i);
  if (pm) {
    transition(s, "predicting");
    const arg = pm[1]?.trim() ?? "";
    const matchParts = arg.match(/^(.+)\s+vs\.?\s+(.+)$/i);

    let matchLabel: string;
    let dataCtx   : string;
    let notif     = "";

    if (matchParts) {
      // Match explicite fourni
      const [, teamA, teamB] = matchParts;
      matchLabel = arg;
      await send(chatId, `🔍 Collecte des données : *${teamA.trim()}* vs *${teamB.trim()}*...`);
      dataCtx = await buildMatchContext(teamA.trim(), teamB.trim());
    } else {
      // AUTO-COMPLÉTION : pas de match précis → détection automatique
      await send(chatId, "⚙️ Aucun match spécifié — détection automatique de la compétition majeure du moment...");
      const def = await getDefaultMatch();
      if (!def) {
        transition(s, "idle");
        return send(chatId, "❌ Aucun match majeur trouvé en ce moment. Spécifiez un match : `/pronostic Équipe1 vs Équipe2`");
      }
      matchLabel = def.match;
      dataCtx    = def.context;
      notif      = `⚙️ *Défaut appliqué* : ${def.match}, marchés mixtes\n\n`;
    }

    s.lastMatch   = matchLabel;
    s.lastContext = dataCtx;

    await send(chatId, `${notif}🧠 Analyse prédictive en cours...`);

    const result = await runPrediction(matchLabel, dataCtx);
    addHistory(s, "user", cmd);
    addHistory(s, "assistant", result);
    transition(s, "awaiting_market");
    return send(chatId, result);
  }

  // ── Marché additionnel (si en état awaiting_market) ───
  // L'utilisateur peut demander un marché supplémentaire sur le dernier match analysé
  if (s.phase === "awaiting_market" && s.lastMatch && /^(over|under|btts|score|double|1x2|résultat|mi-temps)/i.test(cmd)) {
    transition(s, "predicting");
    await send(chatId, `🧠 Analyse du marché "${cmd}" sur ${s.lastMatch}...`);
    const extraCtx = `${s.lastContext ?? s.lastMatch}\n\nMarché demandé spécifiquement: ${cmd}`;
    const result   = await runPrediction(s.lastMatch, extraCtx);
    addHistory(s, "user", cmd);
    addHistory(s, "assistant", result);
    transition(s, "awaiting_market");
    return send(chatId, result);
  }

  // ── Conversation libre ────────────────────────────
  transition(s, "idle");
  addHistory(s, "user", cmd);
  const r = await aiChat(cmd, s.history.slice(0, -1));
  const resp = r || "⚽ Je n'ai pas pu traiter ça. Essayez /help.";
  addHistory(s, "assistant", resp);
  return send(chatId, resp);
}

// ══════════════════════════════════════════════════════
//  SERVEUR WEBHOOK
// ══════════════════════════════════════════════════════

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

// Avertissement au démarrage si le secret n'est pas configuré
if (!WEBHOOK_SECRET) {
  console.warn(
    "[SECURITY] TELEGRAM_WEBHOOK_SECRET non configuré — " +
    "toute requête POST est acceptée sans vérification d'origine. " +
    "Définissez ce secret dans Supabase pour protéger le bot."
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("FootBot ⚽ — Système d'Analyse Prédictive Sportive");

  // Vérification du secret webhook Telegram
  // Si TELEGRAM_WEBHOOK_SECRET est défini, il est obligatoire.
  if (WEBHOOK_SECRET) {
    const sig = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`Unauthorized webhook attempt — IP header: ${req.headers.get("x-forwarded-for") ?? "unknown"}`);
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const b = await req.json(), m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch { return new Response("OK"); }
});
