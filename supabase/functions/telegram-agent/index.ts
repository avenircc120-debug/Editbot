// ═══════════════════════════════════════════════════════
//  FOOTBOT — Agent IA Analyse Football
//  SofaScore (unofficial) + Groq AI
// ═══════════════════════════════════════════════════════

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const TG = `https://api.telegram.org/bot${TG_TOKEN}`;

const SF: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "Referer": "https://www.sofascore.com/",
  "Origin": "https://www.sofascore.com",
  "Cache-Control": "no-cache",
};

const LEAGUES: Record<string, { id: number; name: string }> = {
  ucl:        { id: 7,  name: "Champions League" },
  premier:    { id: 17, name: "Premier League" },
  laliga:     { id: 8,  name: "La Liga" },
  ligue1:     { id: 34, name: "Ligue 1" },
  bundesliga: { id: 35, name: "Bundesliga" },
  seriea:     { id: 23, name: "Serie A" },
};

const MAJOR = new Set([7, 17, 8, 34, 35, 23, 679, 44, 771, 242, 119]);

async function sfFetch(path: string): Promise<any> {
  try {
    const r = await fetch(`https://api.sofascore.com/api/v1${path}`, { headers: SF });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

const todayStr = () => new Date().toISOString().split("T")[0];

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" });

// ── Live matches ──────────────────────────────────────

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

// ── Matchs du jour ────────────────────────────────────

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

// ── Classement ────────────────────────────────────────

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

// ── Recherche ─────────────────────────────────────────

async function sfSearch(q: string): Promise<any[]> {
  return (await sfFetch(`/search/all?q=${encodeURIComponent(q)}`))?.results ?? [];
}

// ── Équipe ────────────────────────────────────────────

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
    const iH = e.homeTeam?.id === id, w = iH ? hs > as_ : as_ > hs, d = hs === as_;
    lines.push(`${d ? "🤝" : w ? "✅" : "❌"} ${e.homeTeam?.name} ${hs}-${as_} ${e.awayTeam?.name}`);
    forme.push(d ? "N" : w ? "V" : "D");
  }
  if (forme.length) lines.push(`\n🔥 Forme: ${forme.join("-")}`);
  return lines.join("\n");
}

// ── Joueur ────────────────────────────────────────────

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
    p?.team?.name    ? `⚽ Club: ${p.team.name}`             : "",
    p?.country?.name ? `🌍 Nationalité: ${p.country.name}`   : "",
    p?.position      ? `📍 Poste: ${p.position}`             : "",
    p?.height        ? `📏 Taille: ${p.height} cm`           : "",
    age !== null     ? `🎂 Âge: ${age} ans`                  : "",
    p?.preferredFoot ? `🦶 Pied: ${p.preferredFoot}`         : "",
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

// ── H2H ──────────────────────────────────────────────

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

// ── Pronostic IA ──────────────────────────────────────

async function getPronostic(info: string): Promise<string> {
  const parts = info.split(/\s+vs\.?\s+/i);
  let ctx = info;
  if (parts.length === 2) {
    const [t1, t2, hh] = await Promise.all([
      getTeam(parts[0].trim()), getTeam(parts[1].trim()), getH2H(parts[0].trim(), parts[1].trim()),
    ]);
    ctx = `Match: ${info}\n\n${t1}\n\n${t2}\n\n${hh}`;
  }
  return groq([
    {
      role: "system",
      content: `Tu es un expert analyste football avec 20 ans d'expérience. Réponds en français, format structuré:

🔍 *Analyse tactique*
[2-3 lignes]

📊 *Forces & Faiblesses*
[équipe 1]: ✅ force / ⚠️ faiblesse
[équipe 2]: ✅ force / ⚠️ faiblesse

🎯 *Pronostic*
Résultat: [1/X/2] — Confiance: [%]
BTTS (les deux marquent): [Oui/Non]
Total buts: [Over/Under 2.5]
Score probable: [X-X]

⚡ *Facteur clé*
[1 ligne]`,
    },
    { role: "user", content: `Analyse et pronostique:\n\n${ctx}` },
  ]);
}

// ── Groq AI ───────────────────────────────────────────

const MODELS = ["llama-3.3-70b-versatile", "llama3-8b-8192", "gemma2-9b-it"];

async function groq(msgs: { role: string; content: string }[]): Promise<string> {
  for (const model of MODELS) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: msgs, temperature: 0.6, max_tokens: 1500 }),
      });
      if (!r.ok) continue;
      const d = await r.json(), c = d.choices?.[0]?.message?.content;
      if (c?.trim()) return c.trim();
    } catch { continue; }
  }
  return "";
}

async function aiChat(q: string, hist: { role: string; content: string }[]): Promise<string> {
  return groq([
    {
      role: "system",
      content: `Tu es FootBot, expert analyste football IA. Tu maîtrises tous les championnats, équipes, joueurs, tactiques et statistiques. Réponds en français avec passion et précision.
Commandes: /live, /auj, /classement [ligue], /equipe [nom], /joueur [nom], /h2h [e1] vs [e2], /pronostic [e1] vs [e2]
Ligues: premier, laliga, ligue1, bundesliga, seriea, ucl`,
    },
    ...hist.slice(-10),
    { role: "user", content: q },
  ]);
}

// ── Session ───────────────────────────────────────────

interface Session { history: { role: string; content: string }[]; }
const sessions = new Map<number, Session>();
const getSession = (id: number): Session => {
  if (!sessions.has(id)) sessions.set(id, { history: [] });
  return sessions.get(id)!;
};
const addH = (s: Session, role: string, content: string) => {
  s.history.push({ role, content });
  if (s.history.length > 20) s.history = s.history.slice(-20);
};

// ── Telegram ─────────────────────────────────────────

async function send(chatId: number, text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const c of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "Markdown" }),
    }).catch(() => fetch(`${TG}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: c }),
    }));
  }
}

const typing = (id: number) =>
  fetch(`${TG}/sendChatAction`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: id, action: "typing" }),
  });

// ── Handler ───────────────────────────────────────────

async function handle(chatId: number, text: string) {
  const s = getSession(chatId);
  typing(chatId);
  const cmd = text.trim();

  if (["/start", "/help", "/aide"].includes(cmd)) {
    return send(chatId,
      `⚽ *FootBot — Analyse Football IA*\n\nDonnées SofaScore en temps réel + Groq AI\n\n🔴 /live — Matchs en direct\n📅 /auj — Matchs du jour\n🏆 /classement [ligue] — Classement\n⚽ /equipe [nom] — Infos équipe\n👤 /joueur [nom] — Stats joueur\n⚔️ /h2h [e1] vs [e2] — Historique\n🎯 /pronostic [e1] vs [e2] — Pronostic IA\n\n*Ligues:* premier · laliga · ligue1 · bundesliga · seriea · ucl\n\nOu posez n'importe quelle question football ! 🎙️`
    );
  }

  if (cmd === "/live") {
    const r = await getLive(); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r);
  }
  if (cmd === "/auj" || cmd === "/aujourd'hui" || cmd === "/today") {
    const r = await getToday(); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r);
  }

  const cm = cmd.match(/^\/classement\s+(\w+)$/i);
  if (cm) { const r = await getStandings(cm[1]); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r); }

  const em = cmd.match(/^\/equipe\s+(.+)$/i);
  if (em) { const r = await getTeam(em[1].trim()); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r); }

  const jm = cmd.match(/^\/joueur\s+(.+)$/i);
  if (jm) { const r = await getPlayer(jm[1].trim()); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r); }

  const hm = cmd.match(/^\/h2h\s+(.+)\s+vs\.?\s+(.+)$/i);
  if (hm) { const r = await getH2H(hm[1].trim(), hm[2].trim()); addH(s, "user", cmd); addH(s, "assistant", r); return send(chatId, r); }

  const pm = cmd.match(/^\/pronostic\s+(.+)$/i);
  if (pm) {
    await send(chatId, "🔍 Analyse en cours...");
    const r = await getPronostic(pm[1].trim()); addH(s, "user", cmd); addH(s, "assistant", r);
    return send(chatId, r || "❌ Analyse non disponible. Réessayez.");
  }

  addH(s, "user", cmd);
  const r = await aiChat(cmd, s.history.slice(0, -1));
  const resp = r || "⚽ Je n'ai pas pu traiter ça. Essayez /help.";
  addH(s, "assistant", resp);
  return send(chatId, resp);
}

// ── Serveur ───────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("FootBot ⚽ — Analyse Football IA");
  try {
    const b = await req.json(), m = b?.message;
    if (m?.text && m?.chat?.id) handle(m.chat.id, m.text.trim()).catch(console.error);
    return new Response("OK");
  } catch { return new Response("OK"); }
});
