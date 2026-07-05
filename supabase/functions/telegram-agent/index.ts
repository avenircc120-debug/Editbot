// ═══════════════════════════════════════════════════════════════════
//  FOOTBOT v10 — Architecture 21 000+ utilisateurs
//  ┌──────────────────────────────────────────────────────────────┐
//  │  Auth       → Service Account Google (JWT RS256, sans OAuth) │
//  │  Données    → Google Sheets API v4 (IMPORTHTML intermédiaire)│
//  │  Cache L1   → Map in-memory (30 min)                        │
//  │  Cache L2   → Onglet Predictions_Cache Google Sheets (24 h) │
//  │  Analyse IA → Groq llama-3.3-70b                            │
//  │  Live       → ESPN API (temps réel, sans bannissement)       │
//  │  Sortie     → Telegram webhook (fire-and-forget)             │
//  └──────────────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════

// ── Variables d'environnement ─────────────────────────────────────
const TG_TOKEN      = Deno.env.get("TELEGRAM_BOT_TOKEN")          ?? "";
const GROQ_KEY      = Deno.env.get("GROQ_API_KEY")                ?? "";
const SB_URL        = Deno.env.get("SUPABASE_URL")                ?? "";
const SB_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")   ?? "";
const SHEETS_ID     = Deno.env.get("GOOGLE_SHEETS_ID")            ?? "";
const TG_WH_SECRET  = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")     ?? ""; // auth webhook
// Service Account (remplace OAuth 2.0 — plus de refresh token)
const SA_EMAIL      = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const SA_KEY_RAW    = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")   ?? ""; // PEM PKCS8

const TG         = `https://api.telegram.org/bot${TG_TOKEN}`;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_FAST  = "llama-3.1-8b-instant";
const ESPN_BASE  = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_HDR   = { "User-Agent": "Mozilla/5.0 (compatible; FootBot/10.0)" };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Ligues ESPN / onglets Sheets ──────────────────────────────────
const LEAGUES: Record<string, string> = {
  "premier league":"eng.1","pl":"eng.1","angleterre":"eng.1","epl":"eng.1",
  "la liga":"esp.1","liga":"esp.1","espagne":"esp.1",
  "ligue 1":"fra.1","ligue1":"fra.1","france":"fra.1",
  "bundesliga":"ger.1","allemagne":"ger.1",
  "serie a":"ita.1","italie":"ita.1",
  "champions league":"uefa.champions","ldc":"uefa.champions",
  "ucl":"uefa.champions","ligue des champions":"uefa.champions",
  "europa league":"uefa.europa","el":"uefa.europa","ligue europa":"uefa.europa",
  "conference league":"uefa.europa.conf","uecl":"uefa.europa.conf",
  "mls":"usa.1","eredivisie":"ned.1",
};
const LEAGUE_TABS: Record<string,string> = {
  "eng.1":"PL_Stand","esp.1":"Liga_Stand","fra.1":"L1_Stand",
  "ger.1":"Bund_Stand","ita.1":"SA_Stand","uefa.champions":"UCL_Stand",
  "uefa.europa":"EL_Stand","uefa.europa.conf":"UECL_Stand",
  "usa.1":"MLS_Stand","ned.1":"Eredivisie_Stand",
};

function detectLeague(text: string): string {
  const l = text.toLowerCase();
  for (const [k,v] of Object.entries(LEAGUES).sort((a,b) => b[0].length - a[0].length)) {
    if (k.length <= 4) { if (new RegExp(`(?<![a-z])${k}(?![a-z])`, "i").test(l)) return v; }
    else if (l.includes(k)) return v;
  }
  return "fra.1";
}

// ══════════════════════════════════════════════════════════════════
//  COUCHE AUTH — Service Account JWT RS256
//  Aucune intervention humaine : le bot génère lui-même ses tokens.
// ══════════════════════════════════════════════════════════════════

let _saToken: { token: string; expiresAt: number } | null = null;

/** Encode en base64url (sans padding). */
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Crée et signe un JWT RS256 pour le Service Account Google. */
async function createServiceAccountJWT(): Promise<string> {
  if (!SA_EMAIL || !SA_KEY_RAW) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / KEY non configurés");

  // Parse clé PEM PKCS8 → DER binaire
  const pemBody = SA_KEY_RAW
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss:   SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  }));

  const input = `${header}.${payload}`;
  const sig   = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** Obtient un access token via le JWT Service Account (avec cache 55 min). */
async function getAccessToken(force = false): Promise<string> {
  if (!force && _saToken && _saToken.expiresAt > Date.now() + 60_000) return _saToken.token;
  _saToken = null;
  try {
    const jwt = await createServiceAccountJWT();
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion:  jwt,
      }),
    });
    if (!res.ok) { console.error("SA token error:", await res.text()); return ""; }
    const d = await res.json();
    if (!d.access_token) return "";
    _saToken = { token: d.access_token, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    return d.access_token;
  } catch (e) { console.error("createJWT error:", e); return ""; }
}

// ══════════════════════════════════════════════════════════════════
//  COUCHE DONNÉES — Google Sheets API v4
//  Le bot ne scrape JAMAIS directement. Il lit des cellules Sheets
//  alimentées par =IMPORTHTML() / =IMPORTXML() configurées par l'admin.
// ══════════════════════════════════════════════════════════════════

/** Détecte si une valeur est une erreur Sheets (#N/A, #ERROR, etc.). */
function isSheetError(v: string): boolean {
  return /^#(N\/A|ERROR|REF|VALUE|DIV\/0|NAME\?|NUM\!|NULL\!)$/i.test(v.trim());
}

/** Filtre les cellules erronées d'une ligne. */
function cleanRow(row: string[]): string[] {
  return row.map(c => isSheetError(c) ? "" : c);
}

/** Lit une plage Sheets. Retente sur 401 (token expiré). */
async function sheetsRead(tab: string, range = "A1:Z100"): Promise<string[][]> {
  if (!SHEETS_ID) return [];

  const doFetch = async (token: string): Promise<Response | null> => {
    const enc  = encodeURIComponent(`${tab}!${range}`);
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${enc}`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 14_000);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      clearTimeout(t); return r;
    } catch { clearTimeout(t); return null; }
  };

  let token = await getAccessToken();
  if (!token) return [];
  let r = await doFetch(token);
  if (r && (r.status === 401 || r.status === 403)) {
    token = await getAccessToken(true);
    if (!token) return [];
    r = await doFetch(token);
  }
  if (!r || !r.ok) return [];
  const d = await r.json();
  const rows = (d.values ?? []) as string[][];
  return rows.map(cleanRow);
}

/** Ajoute une ligne dans un onglet Sheets (pour le cache). */
async function sheetsAppend(tab: string, row: string[]): Promise<void> {
  if (!SHEETS_ID) return;
  const token = await getAccessToken();
  if (!token) return;
  const enc = encodeURIComponent(`${tab}!A:Z`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${enc}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
  } catch {}
}

/** Ajoute une ligne avec retry sur 401 (même robustesse que sheetsRead). */
async function sheetsAppendWithRetry(tab: string, row: string[]): Promise<void> {
  if (!SHEETS_ID) return;
  const doAppend = async (token: string): Promise<number> => {
    const enc = encodeURIComponent(`${tab}!A:Z`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${enc}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [row] }),
        signal: ctrl.signal,
      });
      clearTimeout(t); return r.status;
    } catch { clearTimeout(t); return 0; }
  };
  let token = await getAccessToken();
  if (!token) return;
  const status = await doAppend(token);
  if (status === 401 || status === 403) {
    token = await getAccessToken(true);
    if (token) await doAppend(token);
  }
}

function sheetToText(rows: string[][], sep = " | "): string {
  if (!rows.length) return "Données non disponibles.";
  return rows
    .filter(r => r.some(c => c && !isSheetError(c)))
    .map(r => r.join(sep))
    .join("\n");
}

// ── Outils Sheets ─────────────────────────────────────────────────

async function toolSheetsStandings(league: string): Promise<string> {
  const tab  = LEAGUE_TABS[league] ?? "L1_Stand";
  const rows = await sheetsRead(tab, "A1:K25");
  if (!rows.length) return `❌ Onglet <b>${tab}</b> vide ou IMPORTHTML non encore chargé.`;
  return `📊 <b>Classement</b>\n<pre>${sheetToText(rows)}</pre>`;
}

async function toolSheetsMatchsToday(): Promise<string> {
  const rows = await sheetsRead("Matchs_Auj", "A1:H60");
  if (!rows.length) return "";
  return `📅 <b>Matchs du jour</b>\n<pre>${sheetToText(rows)}</pre>`;
}

async function toolSheetsTeam(team: string): Promise<string> {
  const rows   = await sheetsRead("Equipes", "A1:J200");
  if (!rows.length) return `❌ Onglet <b>Equipes</b> introuvable.`;
  const header = rows[0] ?? [];
  const lower  = team.toLowerCase();
  const found  = rows.slice(1).filter(r => r[0]?.toLowerCase().includes(lower));
  if (!found.length) return `❓ <b>${team}</b> non trouvée dans l'onglet Equipes.`;
  return `🏟️ <b>${team}</b>\n<pre>${found.map(r =>
    header.map((h,i) => `${h}: ${r[i] ?? "-"}`).join(" | ")).join("\n")}</pre>`;
}

async function toolSheetsH2H(home: string, away: string): Promise<string> {
  const rows  = await sheetsRead("H2H", "A1:J200");
  if (!rows.length) return `❌ Onglet <b>H2H</b> introuvable.`;
  const lh = home.toLowerCase(), la = away.toLowerCase();
  const found = rows.filter(r =>
    (r[0]?.toLowerCase().includes(lh) && r[2]?.toLowerCase().includes(la)) ||
    (r[0]?.toLowerCase().includes(la) && r[2]?.toLowerCase().includes(lh))
  );
  if (!found.length) return `❓ Aucun H2H pour <b>${home} vs ${away}</b>.`;
  return `🆚 <b>H2H ${home} vs ${away}</b>\n<pre>${sheetToText(found)}</pre>`;
}

// ── Structure pronostic ───────────────────────────────────────────
interface MatchProno {
  home: string; away: string; league: string; date: string;
  homeForm: string; awayForm: string; stats: string;
}

async function getSheetsPronoMatches(count: number): Promise<MatchProno[]> {
  const rows = await sheetsRead("Pronostics", `A2:J${count + 20}`);
  return rows
    .filter(r => r[0] && r[1] && !isSheetError(r[0]) && !isSheetError(r[1]))
    .slice(0, count)
    .map(r => ({
      home: r[0] ?? "", away: r[1] ?? "", league: r[2] ?? "",
      date: r[3] ?? "", homeForm: r[4] ?? "", awayForm: r[5] ?? "",
      stats: r.slice(6).filter(c => c && !isSheetError(c)).join(" | "),
    }));
}

async function getAllSheetsPronoMatches(): Promise<MatchProno[]> {
  return getSheetsPronoMatches(30);
}

// ══════════════════════════════════════════════════════════════════
//  COUCHE CACHE — Double niveau pour 21 000+ utilisateurs
//  L1 : Map in-memory (30 min) — zéro latence réseau
//  L2 : Onglet Predictions_Cache Google Sheets (24 h)
// ══════════════════════════════════════════════════════════════════

interface CachedAnalysis {
  market: string; choice: string; confidence: number; reason: string;
}

// Cache L1 — in-memory
const L1_CACHE = new Map<string, { ts: number; data: CachedAnalysis }>();
const L1_TTL   = 30 * 60 * 1000;  // 30 minutes
let   _l1PurgeCount = 0;

/** Purge les entrées expirées du cache L1 (appelé toutes les 50 écritures). */
function purgeL1(): void {
  const now = Date.now();
  for (const [k, v] of L1_CACHE) { if (now - v.ts >= L1_TTL) L1_CACHE.delete(k); }
}

// Cache L2 — Google Sheets "Predictions_Cache"
// Structure : A=MatchKey | B=TimestampMs | C=Market | D=Choice | E=Confidence | F=Reason
const L2_TTL = 24 * 60 * 60 * 1000; // 24 heures
let _l2Cache: Array<{ key:string; ts:number; data:CachedAnalysis }> | null = null;
let _l2CacheLoadedAt = 0;
const L2_RELOAD_INTERVAL = 5 * 60 * 1000; // recharge L2 en mémoire toutes les 5 min

function makeMatchKey(home: string, away: string, date: string): string {
  return `${home.toLowerCase().trim()}|${away.toLowerCase().trim()}|${(date || "").trim()}`;
}

/** Charge l'onglet Predictions_Cache en mémoire (max toutes les 5 min).
 *  Déduplique par clé en conservant l'entrée la plus récente. */
async function loadL2Cache(): Promise<void> {
  if (_l2Cache !== null && Date.now() - _l2CacheLoadedAt < L2_RELOAD_INTERVAL) return;
  const rows = await sheetsRead("Predictions_Cache", "A2:F1000");
  // Déduplique : pour chaque clé on garde l'entrée au timestamp le plus élevé
  const byKey = new Map<string, { key:string; ts:number; data:CachedAnalysis }>();
  for (const r of rows) {
    if (!r[0] || !r[1]) continue;
    const ts = parseInt(r[1] ?? "0", 10);
    const existing = byKey.get(r[0]);
    if (!existing || ts > existing.ts) {
      byKey.set(r[0], {
        key:  r[0],
        ts,
        data: { market: r[2] ?? "", choice: r[3] ?? "", confidence: parseInt(r[4] ?? "55", 10), reason: r[5] ?? "" },
      });
    }
  }
  _l2Cache = [...byKey.values()];
  _l2CacheLoadedAt = Date.now();
}

async function checkCache(key: string): Promise<CachedAnalysis | null> {
  const now = Date.now();
  // L1
  const l1 = L1_CACHE.get(key);
  if (l1 && now - l1.ts < L1_TTL) return l1.data;
  // L2
  await loadL2Cache();
  const l2 = _l2Cache?.find(e => e.key === key && now - e.ts < L2_TTL);
  if (l2) { L1_CACHE.set(key, { ts: now, data: l2.data }); return l2.data; }
  return null;
}

async function writeCache(key: string, data: CachedAnalysis): Promise<void> {
  const now = Date.now();
  L1_CACHE.set(key, { ts: now, data });
  // Purge périodique L1 pour éviter la fuite mémoire (toutes les 50 écritures)
  if (++_l1PurgeCount % 50 === 0) purgeL1();
  if (_l2Cache) {
    // Mise à jour en mémoire : remplace l'entrée existante (pas d'appends dupliqués)
    const idx = _l2Cache.findIndex(e => e.key === key);
    if (idx >= 0) _l2Cache[idx] = { key, ts: now, data };
    else _l2Cache.push({ key, ts: now, data });
  }
  // Écriture asynchrone en arrière-plan (non bloquant)
  sheetsAppendWithRetry("Predictions_Cache", [
    key, String(now), data.market, data.choice, String(data.confidence), data.reason,
  ]).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
//  COUCHE ESPN — Scores live (temps réel, zéro risque ban)
// ══════════════════════════════════════════════════════════════════

async function espnFetch(url: string, attempt = 0): Promise<any> {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 12_000);
    const r    = await fetch(url, { headers: ESPN_HDR, signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 2) { await sleep(1500*(attempt+1)); return espnFetch(url, attempt+1); }
    return null;
  } catch {
    if (attempt < 2) { await sleep(1000); return espnFetch(url, attempt+1); }
    return null;
  }
}

async function toolEspnLiveScores(): Promise<string> {
  const ls = ["eng.1","esp.1","fra.1","ger.1","ita.1","uefa.champions","uefa.europa"];
  const lines: string[] = [];
  await Promise.all(ls.map(async l => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const sn = ev.status?.type?.name ?? "";
      if (!["STATUS_IN_PROGRESS","STATUS_HALFTIME"].includes(sn)) continue;
      const c = ev.competitions?.[0];
      const h = c?.competitors?.find((x:any)=>x.homeAway==="home");
      const a = c?.competitors?.find((x:any)=>x.homeAway==="away");
      if (!h || !a) continue;
      lines.push(`⚽ ${h.team.shortDisplayName} ${h.score}–${a.score} ${a.team.shortDisplayName} (${ev.status?.type?.shortDetail ?? ""})`);
    }
  }));
  return lines.length ? `🔴 <b>En direct</b>\n${lines.join("\n")}` : "Aucun match en direct actuellement.";
}

async function toolEspnScheduleToday(): Promise<string> {
  const ls = ["eng.1","esp.1","fra.1","ger.1","ita.1","uefa.champions","uefa.europa"];
  const lines: string[] = [];
  await Promise.all(ls.map(async l => {
    const d = await espnFetch(`${ESPN_BASE}/${l}/scoreboard`);
    if (!d?.events) return;
    for (const ev of d.events) {
      const c  = ev.competitions?.[0];
      const h  = c?.competitors?.find((x:any)=>x.homeAway==="home");
      const a  = c?.competitors?.find((x:any)=>x.homeAway==="away");
      if (!h || !a) continue;
      const sn = ev.status?.type?.name ?? "";
      const tm = ev.date ? new Date(ev.date).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Paris"}) : "";
      if (sn==="STATUS_FINAL")
        lines.push(`✅ ${h.team.shortDisplayName} ${h.score}–${a.score} ${a.team.shortDisplayName} (FT)`);
      else if (["STATUS_IN_PROGRESS","STATUS_HALFTIME"].includes(sn))
        lines.push(`🔴 ${h.team.shortDisplayName} ${h.score}–${a.score} ${a.team.shortDisplayName} (Live)`);
      else
        lines.push(`🕐 ${tm} — ${h.team.shortDisplayName} vs ${a.team.shortDisplayName}`);
    }
  }));
  return lines.length ? `📅 <b>Matchs du jour</b>\n${lines.join("\n")}` : "Aucun match programmé aujourd'hui.";
}

// ══════════════════════════════════════════════════════════════════
//  COUCHE IA — Groq Analysis (avec cache + rate-limit backoff)
//  Prompt exact demandé par l'administrateur.
// ══════════════════════════════════════════════════════════════════

// ── Sémaphore global Groq ─────────────────────────────────────────
// Borne le nombre d'appels Groq SIMULTANÉS toutes requêtes confondues
// pour ne pas dépasser le rate limit même avec 21k users en parallèle.
const GROQ_MAX_CONCURRENT = 3;
let   _groqActive = 0;
const _groqQueue: Array<() => void> = [];

function groqAcquire(): Promise<void> {
  if (_groqActive < GROQ_MAX_CONCURRENT) { _groqActive++; return Promise.resolve(); }
  return new Promise(resolve => _groqQueue.push(resolve));
}
function groqRelease(): void {
  const next = _groqQueue.shift();
  if (next) { next(); } else { _groqActive--; }
}

/** Appel Groq avec sémaphore global + retry automatique sur 429. */
async function groqCall(model: string, messages: any[], maxTokens = 512, attempt = 0): Promise<string> {
  await groqAcquire();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    });
    if (res.status === 429 && attempt < 3) {
      const retry = parseInt(res.headers.get("retry-after") ?? "2", 10);
      groqRelease();
      await sleep((retry || 2) * 1000 * (attempt + 1));
      return groqCall(model, messages, maxTokens, attempt + 1);
    }
    if (!res.ok) return "";
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? "";
  } finally {
    groqRelease();
  }
}

/** Analyse IA d'un match — cache L1+L2 avant d'appeler Groq. */
async function analyseMatchGroq(m: MatchProno): Promise<CachedAnalysis> {
  const key = makeMatchKey(m.home, m.away, m.date);

  // Vérification cache (L1 → L2)
  const cached = await checkCache(key);
  if (cached) return cached;

  // Construction du prompt exact demandé
  const statsBlock = [
    m.homeForm ? `Forme ${m.home} : ${m.homeForm}` : null,
    m.awayForm ? `Forme ${m.away} : ${m.awayForm}` : null,
    m.stats    ? `Statistiques : ${m.stats}`        : null,
    m.league   ? `Compétition : ${m.league}`        : null,
    m.date     ? `Date : ${m.date}`                 : null,
  ].filter(Boolean).join("\n");

  const userPrompt =
    `Tu es un expert en analyse statistique footballistique. ` +
    `Basé sur les données suivantes :\n${statsBlock}\n\n` +
    `Match : ${m.home} vs ${m.away}\n\n` +
    `Fournis une analyse concise, un pronostic probabiliste et un conseil de pari. ` +
    `Reste objectif et professionnel.\n\n` +
    `Réponds UNIQUEMENT en JSON valide :\n` +
    `{"market":"1X2 ou BTTS ou Over/Under 2.5","choice":"sélection précise","confidence":70,"reason":"2 phrases max"}`;

  const raw = await groqCall(GROQ_FAST, [
    { role: "system", content: "Expert football. Réponds uniquement en JSON valide." },
    { role: "user",   content: userPrompt },
  ], 256);

  let result: CachedAnalysis;
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const p    = JSON.parse(json);
    result     = {
      market:     p.market     ?? "1X2",
      choice:     p.choice     ?? m.home,
      confidence: parseInt(p.confidence ?? 55, 10),
      reason:     p.reason     ?? "Analyse indisponible.",
    };
  } catch {
    result = { market: "1X2", choice: m.home, confidence: 55, reason: "Analyse impossible." };
  }

  // Écriture cache (non bloquant)
  writeCache(key, result).catch(() => {});
  return result;
}

// ── Agent Groq conversationnel (questions générales) ──────────────

type ChatMessage = { role: "user" | "assistant"; content: string };

const GROQ_TOOLS = [
  { type:"function", function:{
    name:"get_live_scores",
    description:"Scores des matchs en direct (ESPN, temps réel).",
    parameters:{type:"object",properties:{}},
  }},
  { type:"function", function:{
    name:"get_matches_today",
    description:"Matchs du jour : résultats, en cours, à venir.",
    parameters:{type:"object",properties:{}},
  }},
  { type:"function", function:{
    name:"get_standings",
    description:"Classement d'une ligue depuis Google Sheets.",
    parameters:{type:"object",properties:{league:{type:"string",description:"Nom de la ligue"}},required:["league"]},
  }},
  { type:"function", function:{
    name:"get_team_info",
    description:"Infos et forme d'une équipe depuis Google Sheets.",
    parameters:{type:"object",properties:{team:{type:"string",description:"Nom de l'équipe"}},required:["team"]},
  }},
  { type:"function", function:{
    name:"get_h2h",
    description:"Confrontations directes entre deux équipes depuis Google Sheets.",
    parameters:{type:"object",properties:{
      home:{type:"string"},away:{type:"string"},
    },required:["home","away"]},
  }},
];

const SYS_AGENT = `Tu es FootBot ⚽ v10, assistant football expert. Tu réponds TOUJOURS en français.
Architecture : Google Sheets (IMPORTHTML) → Bot → Groq AI → Telegram.
- Pour toute question football → appelle systématiquement les outils disponibles avant de répondre.
- Ne fabrique JAMAIS de chiffres ou stats — utilise uniquement les données des outils.
- Si les données sont vides ou #N/A → dis-le clairement.
- Pour des pronostics → guide l'utilisateur vers /pronostic [équipe1] vs [équipe2] ou envoie un chiffre.
- Concis, précis, emojis football.`;

async function execTool(name: string, args: Record<string,any>): Promise<string> {
  switch (name) {
    case "get_live_scores":   return toolEspnLiveScores();
    case "get_matches_today": return toolEspnScheduleToday();
    case "get_standings":     return toolSheetsStandings(detectLeague(args.league ?? ""));
    case "get_team_info":     return toolSheetsTeam(args.team ?? "");
    case "get_h2h":           return toolSheetsH2H(args.home ?? "", args.away ?? "");
    default:                  return "Outil inconnu.";
  }
}

/** Appel Groq avec outils (tool-calling), protégé par le sémaphore global. */
async function groqCallWithTools(messages: any[]): Promise<{ ok: boolean; data: any; status: number }> {
  await groqAcquire();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:`Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model:GROQ_MODEL, messages, tools:GROQ_TOOLS, tool_choice:"auto", max_tokens:1024 }),
    });
    const data = res.ok ? await res.json() : null;
    return { ok: res.ok, data, status: res.status };
  } finally {
    groqRelease();
  }
}

async function groqAgent(userMsg: string, history: ChatMessage[], firstName?: string): Promise<string> {
  const messages: any[] = [
    { role:"system", content: SYS_AGENT + (firstName ? `\nUtilisateur : ${firstName}.` : "") },
    ...history.slice(-8),
    { role:"user", content: userMsg },
  ];
  for (let i = 0; i < 5; i++) {
    const { ok, data, status } = await groqCallWithTools(messages);
    if (status === 429) { await sleep(2000); continue; }
    if (!ok || !data)   return "❌ Erreur IA. Réessaie.";
    const choice = data.choices?.[0];
    const msg    = choice?.message;
    if (!msg) break;
    messages.push(msg);
    if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args: Record<string,any> = {};
        try { args = JSON.parse(tc.function.arguments ?? "{}"); } catch {}
        messages.push({ role:"tool", content: await execTool(tc.function.name, args), tool_call_id: tc.id });
      }
      continue;
    }
    return msg.content ?? "";
  }
  return "Réessaie.";
}

// ══════════════════════════════════════════════════════════════════
//  PIPELINE PRONOSTICS — Sheets → Cache → Groq → Telegram
// ══════════════════════════════════════════════════════════════════

function confBar(pct: number): string {
  const f = Math.min(Math.round(pct/10), 10);
  return "█".repeat(f) + "░".repeat(10-f) + ` ${pct}%`;
}

function formatProno(m: MatchProno, a: CachedAnalysis): string {
  return (
    `⚽ <b>${m.home} vs ${m.away}</b>\n` +
    `🏆 ${m.league || "?"} · ${m.date || "Prochain match"}\n` +
    `📊 Forme : ${m.homeForm?.split("\n")[0]?.slice(0,60) || "N/A"} / ${m.awayForm?.split("\n")[0]?.slice(0,60) || "N/A"}\n` +
    `───────────────────────\n` +
    `📌 Marché : <b>${a.market}</b>\n` +
    `✅ Pronostic : <b>${a.choice}</b>\n` +
    `📈 Confiance : ${confBar(a.confidence)}\n` +
    `💬 ${a.reason}`
  );
}

async function runPipeline(chatId: number, count: number): Promise<void> {
  await send(chatId, `⏳ Analyse de <b>${count} match${count>1?"s":""}</b>…\n(Cache vérifié avant chaque appel IA)`);
  const tok = keepTyping(chatId, 240_000);
  try {
    const matches = await getSheetsPronoMatches(count);
    if (!matches.length) {
      tok.cancel();
      await send(chatId,
        "❌ <b>Onglet Pronostics vide ou #N/A.</b>\n\n" +
        "Structure attendue :\n" +
        "A=Domicile | B=Extérieur | C=Ligue | D=Date | E=Forme Dom | F=Forme Ext"
      );
      return;
    }

    // Traitement par batch de 3 (limite Groq 30 RPM)
    const analyses: CachedAnalysis[] = [];
    const BATCH = 3;
    for (let j = 0; j < matches.length; j += BATCH) {
      const batch = await Promise.all(matches.slice(j, j+BATCH).map(m => analyseMatchGroq(m)));
      analyses.push(...batch);
      if (j + BATCH < matches.length) await sleep(700);
    }
    tok.cancel();

    for (let i = 0; i < matches.length; i++) {
      await send(chatId, formatProno(matches[i], analyses[i]));
      if (i < matches.length-1) await sleep(350);
    }
  } catch (e) {
    tok.cancel();
    console.error("runPipeline error:", e);
    await send(chatId, "❌ Erreur lors de l'analyse. Réessaie.");
  }
}

// ══════════════════════════════════════════════════════════════════
//  SUPABASE SESSION
// ══════════════════════════════════════════════════════════════════

type Phase = "idle" | "awaiting_count";

function sbH(): Record<string,string> {
  return { apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`,
           "Content-Type":"application/json", Prefer:"resolution=merge-duplicates,return=minimal" };
}

async function loadSession(chatId: number): Promise<{ phase: Phase; history: ChatMessage[] }> {
  if (!SB_URL || !SB_KEY) return { phase:"idle", history:[] };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/bot_sessions?chat_id=eq.${chatId}&select=phase,history`, { headers:sbH() });
    if (!r.ok) return { phase:"idle", history:[] };
    const rows = await r.json() as any[];
    const row  = rows?.[0];
    let history: ChatMessage[] = [];
    try { history = row?.history ? JSON.parse(row.history) : []; } catch {}
    return { phase:(row?.phase as Phase) ?? "idle", history };
  } catch { return { phase:"idle", history:[] }; }
}

async function saveSession(chatId: number, phase: Phase, history: ChatMessage[]): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/bot_sessions`, {
      method:"POST", headers:sbH(),
      body: JSON.stringify({ chat_id:chatId, phase, history:JSON.stringify(history.slice(-10)) }),
    });
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════════════════

async function send(chatId: number, text: string): Promise<void> {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:chatId, text:chunk, parse_mode:"HTML" }),
    }).catch(()=>{});
    if (chunks.length > 1) await sleep(300);
  }
}

async function typing(chatId: number): Promise<void> {
  await fetch(`${TG}/sendChatAction`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id:chatId, action:"typing" }),
  }).catch(()=>{});
}

interface CancelToken { cancel: () => void }
function keepTyping(chatId: number, maxMs: number): CancelToken {
  let done = false;
  (async () => {
    let el = 0;
    while (!done && el < maxMs) { await typing(chatId); await sleep(4000); el += 4000; }
  })();
  return { cancel: () => { done = true; } };
}

// ══════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════

const MATCH_COUNT_RE = /(\d+)\s*match/i;

function extractNumber(t: string): number | null {
  const m = t.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= 20 ? n : null;
}

function isPronoIntent(t: string): boolean {
  return /\b(pronostic|prono|pronos|tip\b|tips\b|pari\b|mise\b|prédiction|prediction|predire|prédire|coup sûr|pick\b|picks\b)\b/i.test(t);
}

const NOT_TEAM = /^(react|vue|angular|node|python|java|php|sql|html|css|le|la|les|des|un|une|qui|que|comment|pourquoi|quand|où|oui|non|ok|yes|no)$/i;
function extractVsTeams(text: string, requireProno = true): [string, string] | null {
  if (requireProno && !isPronoIntent(text)) return null;
  const m = text.match(/\b([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ\s'\-]{1,23}?)\s+vs\.?\s+([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ\s'\-]{1,23})\b/i);
  if (!m) return null;
  const [home, away] = [m[1].trim(), m[2].trim()];
  if (NOT_TEAM.test(home) || NOT_TEAM.test(away)) return null;
  if (home.length < 2 || away.length < 2) return null;
  return [home, away];
}

async function handle(chatId: number, raw: string, firstName?: string): Promise<void> {
  const lower = raw.toLowerCase().trim();
  const { phase, history } = await loadSession(chatId);

  // ── Réponse après prompt "combien de matchs ?" ───────────────
  if (phase === "awaiting_count") {
    const num = extractNumber(raw);
    await saveSession(chatId, "idle", history);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // ── /start · salutation ───────────────────────────────────────
  if (/^(salut|bonjour|hello|bonsoir|hi|coucou|start|\/start)$/i.test(lower)) {
    const name = firstName ? ` ${firstName}` : "";
    await send(chatId,
      `⚽ Bienvenue${name} sur <b>FootBot v10</b> !\n\n` +
      `🏗️ <b>Architecture :</b> Google Sheets → IA Groq → Telegram\n` +
      `⚡ Cache double couche — supporte <b>21 000+ utilisateurs</b>\n\n` +
      `<b>Commandes :</b>\n` +
      `/live — Scores en direct (ESPN)\n` +
      `/auj — Matchs du jour\n` +
      `/classement Ligue 1 — Classement\n` +
      `/equipe PSG — Infos équipe\n` +
      `/h2h PSG vs OM — Historique confrontations\n` +
      `/pronostic PSG vs OM — Analyse IA (avec cache)\n\n` +
      `💡 <b>Raccourcis :</b> envoie <b>3</b> pour 3 pronostics, <b>5</b> pour 5, etc.\n` +
      `💬 Ou pose une question en langage naturel !\n\n` +
      `📊 <b>Exemple de sortie :</b>\n` +
      `⚽ <b>PSG vs Marseille</b>\n` +
      `📌 Marché : <b>1X2</b>  ✅ <b>Victoire PSG</b>\n` +
      `📈 ████████░░ 80%\n` +
      `💬 PSG dominant à domicile, 8V en 10 H2H.`
    );
    return;
  }

  // ── /live ─────────────────────────────────────────────────────
  if (/^\/live/i.test(lower) || lower === "live") {
    const tok = keepTyping(chatId, 30_000);
    const res = await toolEspnLiveScores();
    tok.cancel(); await send(chatId, res); return;
  }

  // ── /auj ─────────────────────────────────────────────────────
  if (/^\/auj/i.test(lower) || lower === "auj") {
    const tok = keepTyping(chatId, 30_000);
    const sheets = await toolSheetsMatchsToday();
    const res    = sheets || await toolEspnScheduleToday();
    tok.cancel(); await send(chatId, res); return;
  }

  // ── /classement ───────────────────────────────────────────────
  if (/^\/classement/i.test(lower)) {
    const q   = raw.replace(/\/classement/i,"").trim() || "ligue 1";
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsStandings(detectLeague(q));
    tok.cancel(); await send(chatId, res); return;
  }

  // ── /equipe ───────────────────────────────────────────────────
  if (/^\/equipe/i.test(lower)) {
    const team = raw.replace(/\/equipe/i,"").trim();
    if (!team) { await send(chatId, "Usage : /equipe PSG"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsTeam(team);
    tok.cancel(); await send(chatId, res); return;
  }

  // ── /h2h ─────────────────────────────────────────────────────
  if (/^\/h2h/i.test(lower)) {
    const parts = raw.replace(/\/h2h/i,"").trim().split(/\s+vs\s+/i);
    if (parts.length < 2) { await send(chatId, "Usage : /h2h PSG vs OM"); return; }
    const tok = keepTyping(chatId, 30_000);
    const res = await toolSheetsH2H(parts[0].trim(), parts[1].trim());
    tok.cancel(); await send(chatId, res); return;
  }

  // ── /pronostic + "prono X vs Y" en langage naturel ───────────
  const isSlash  = /^\/pronostic/i.test(lower);
  const vsTeams  = !isSlash ? extractVsTeams(raw, true) : null;

  if (isSlash || vsTeams) {
    const parts = isSlash
      ? raw.replace(/\/pronostic/i,"").trim().split(/\s+vs\s+/i)
      : [vsTeams![0], vsTeams![1]];

    if (parts.length >= 2 && parts[0]?.trim() && parts[1]?.trim()) {
      const [home, away] = [parts[0].trim(), parts[1].trim()];
      const tok = keepTyping(chatId, 90_000);
      const [h2h, teamA, teamB] = await Promise.all([
        toolSheetsH2H(home, away),
        toolSheetsTeam(home),
        toolSheetsTeam(away),
      ]);
      const m: MatchProno = {
        home, away, league:"?", date:"Prochain match",
        homeForm: teamA, awayForm: teamB, stats: h2h,
      };
      const a = await analyseMatchGroq(m);
      tok.cancel();
      await send(chatId, formatProno(m, a));
      return;
    }

    // /pronostic seul → pipeline Sheets complet
    if (isSlash) {
      const tok     = keepTyping(chatId, 30_000);
      const matches = await getAllSheetsPronoMatches();
      tok.cancel();
      if (matches.length) { await runPipeline(chatId, matches.length); return; }
      await send(chatId,
        "❌ <b>Onglet Pronostics vide ou IMPORTHTML non chargé (#N/A).</b>\n\n" +
        "Structure attendue (ligne 1 = en-têtes) :\n" +
        "A=Domicile | B=Extérieur | C=Ligue | D=Date | E=Forme Dom | F=Forme Ext"
      );
      return;
    }
  }

  // ── Chiffre brut (ex: "3" ou "5 matchs") ─────────────────────
  if (MATCH_COUNT_RE.test(lower) || /^\d+$/.test(lower)) {
    const num = extractNumber(raw);
    if (num !== null) { await runPipeline(chatId, num); return; }
  }

  // ── Intent prono naturel sans équipes ─────────────────────────
  if (isPronoIntent(lower) && !extractVsTeams(raw, false)) {
    const tok     = keepTyping(chatId, 30_000);
    const matches = await getAllSheetsPronoMatches();
    tok.cancel();
    if (matches.length) {
      await send(chatId, `🔍 <b>${matches.length} match${matches.length>1?"s":""} trouvé${matches.length>1?"s":""} dans Google Sheets.</b>\nLancement de l'analyse IA…`);
      await runPipeline(chatId, matches.length);
      return;
    }
    // Sheets vide → Groq répond
  }

  // ── Agent Groq conversationnel (toutes autres questions) ──────
  const tok    = keepTyping(chatId, 60_000);
  const answer = await groqAgent(raw, history, firstName);
  tok.cancel();
  if (answer) {
    await send(chatId, answer);
    await saveSession(chatId, "idle",
      [...history, { role:"user", content:raw }, { role:"assistant", content:answer }]);
  }
}

// ══════════════════════════════════════════════════════════════════
//  WEBHOOK TELEGRAM
// ══════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response(
      "FootBot v10 ⚽ | Arch: Sheets→Cache→Groq→Telegram | 21 000+ users",
      { headers: { "Content-Type": "text/plain" } },
    );

  // ── Authentification webhook Telegram ────────────────────────
  // Si TELEGRAM_WEBHOOK_SECRET est défini, le header doit correspondre.
  if (TG_WH_SECRET) {
    const incoming = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (incoming !== TG_WH_SECRET) {
      console.warn("Webhook: secret token invalide, requête rejetée.");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const b = await req.json();
    const m = b?.message;
    if (m?.text && m?.chat?.id) {
      const fn = m.from?.first_name ?? m.chat?.first_name ?? undefined;
      // Fire-and-forget : Telegram n'attend pas la réponse
      handle(m.chat.id, m.text.trim(), fn).catch(console.error);
    }
    return new Response("OK");
  } catch { return new Response("OK"); }
});
