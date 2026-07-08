// setup-sheets/index.ts — Scaffold complet Google Sheets
// ─────────────────────────────────────────────────────────────────
//  Crée les 3 onglets maîtres + onglets de classements
//  Auth : Workload Identity Federation (WIF, sans clé JSON stockée)
// ─────────────────────────────────────────────────────────────────

const SHEETS_ID  = Deno.env.get("GOOGLE_SHEETS_ID") ?? "";
const WIF_AUD    = Deno.env.get("GOOGLE_WIF_AUDIENCE") ?? "";
const SA_EMAIL   = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const PEM_KEY    = Deno.env.get("GOOGLE_WIF_SIGNING_KEY") ?? "";
const SUPABASE_REF = "jxrwgcsbomqvvchvkkdt";
const JWKS_ISSUER  = `https://${SUPABASE_REF}.supabase.co/functions/v1/jwks`;
const KID          = "editbot-wif-key-1";

// ── WIF Auth ──────────────────────────────────────────────────────
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function getAccessToken(): Promise<string> {
  if (!WIF_AUD || !SA_EMAIL || !PEM_KEY) throw new Error("Secrets WIF manquants");

  const now = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(PEM_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const pay = b64url(JSON.stringify({ iss: JWKS_ISSUER, sub: "editbot-edge-function", aud: WIF_AUD, iat: now, exp: now + 3600 }));
  const sig  = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${hdr}.${pay}`));
  const jwt  = `${hdr}.${pay}.${b64url(new Uint8Array(sig))}`;

  const stsR = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: WIF_AUD,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: jwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }),
  });
  if (!stsR.ok) throw new Error(`STS ${stsR.status}: ${await stsR.text()}`);
  const { access_token: fedTok } = await stsR.json();

  const impR = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fedTok}` },
      body: JSON.stringify({ scope: ["https://www.googleapis.com/auth/spreadsheets"] }),
    }
  );
  if (!impR.ok) throw new Error(`Impersonate ${impR.status}: ${await impR.text()}`);
  const { accessToken } = await impR.json();
  return accessToken;
}

// ── Sheets API helpers ────────────────────────────────────────────
async function sheetsRequest(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Sheets ${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getExistingSheets(token: string): Promise<Map<string, number>> {
  const data = await sheetsRequest(token, "GET", "?fields=sheets(properties(sheetId,title))");
  const map = new Map<string, number>();
  for (const s of data.sheets ?? []) map.set(s.properties.title, s.properties.sheetId);
  return map;
}

// ── Définition des onglets ────────────────────────────────────────
const SHEETS_CONFIG = [
  // ── 3 onglets maîtres (Phase 1) ────────────────────────────────
  {
    title: "RAW_WEB_DATA",
    color: { red: 0.2, green: 0.6, blue: 1.0 },
    headers: ["ID", "Query", "Titre", "Snippet", "URL Source", "Date Collecte", "Traité", "Expire le"],
    sample: ["(auto)", "Résultats Ligue 1", "Classement Ligue 1 2025-26", "PSG en tête avec 75 pts...", "https://...", new Date().toISOString(), "Non", ""],
  },
  {
    title: "ANALYSE_GROQ",
    color: { red: 1.0, green: 0.6, blue: 0.2 },
    headers: ["ID", "Query", "Synthèse IA", "Sources", "Date Analyse", "Expire le"],
    sample: ["(auto)", "Forme PSG", "Le PSG traverse une période...", "lequipe.fr, goal.com", new Date().toISOString(), ""],
  },
  {
    title: "BASE_CONNAISSANCE",
    color: { red: 0.2, green: 0.8, blue: 0.4 },
    headers: ["ID", "Sujet", "Contenu", "Template Réponse", "Tags", "Mis à jour"],
    sample: ["(auto)", "Salutation", "Je suis Editbot, expert football.", "⚽ {contenu}", "bot,template", new Date().toISOString()],
  },
  // ── Classements (existants) ────────────────────────────────────
  { title: "PL_Stand",         color: { red: 0.4, green: 0.1, blue: 0.6 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "Liga_Stand",       color: { red: 0.9, green: 0.1, blue: 0.1 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "L1_Stand",         color: { red: 0.0, green: 0.3, blue: 0.7 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "Bund_Stand",       color: { red: 1.0, green: 0.8, blue: 0.0 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "SA_Stand",         color: { red: 0.0, green: 0.5, blue: 0.2 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "UCL_Stand",        color: { red: 0.0, green: 0.2, blue: 0.6 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "EL_Stand",         color: { red: 0.9, green: 0.5, blue: 0.0 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "UECL_Stand",       color: { red: 0.2, green: 0.7, blue: 0.5 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "MLS_Stand",        color: { red: 0.8, green: 0.1, blue: 0.2 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
  { title: "Eredivisie_Stand", color: { red: 0.9, green: 0.6, blue: 0.0 }, headers: ["Pos","Équipe","J","G","N","P","Bp","Bc","Diff","Pts"], sample: [] },
];

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST requis", { status: 405 });

  const log: string[] = [];
  try {
    if (!SHEETS_ID) throw new Error("GOOGLE_SHEETS_ID manquant");

    log.push("🔑 Authentification WIF...");
    const token = await getAccessToken();
    log.push("✅ Token obtenu");

    const existing = await getExistingSheets(token);
    log.push(`📋 Onglets existants : ${[...existing.keys()].join(", ") || "aucun"}`);

    const toCreate = SHEETS_CONFIG.filter(s => !existing.has(s.title));
    const toFormat  = SHEETS_CONFIG.filter(s => existing.has(s.title));

    // Créer les onglets manquants
    if (toCreate.length) {
      await sheetsRequest(token, "POST", ":batchUpdate", {
        requests: toCreate.map(s => ({
          addSheet: { properties: { title: s.title, tabColor: s.color } },
        })),
      });
      log.push(`✅ Créés : ${toCreate.map(s => s.title).join(", ")}`);
    }

    // Rafraîchir la liste des IDs
    const allSheets = await getExistingSheets(token);

    // Écrire les en-têtes et données sample
    const updates: Array<{ range: string; values: unknown[][] }> = [];
    for (const s of SHEETS_CONFIG) {
      if (s.headers.length) updates.push({ range: `${s.title}!A1`, values: [s.headers] });
      if (s.sample.length)  updates.push({ range: `${s.title}!A2`, values: [s.sample] });
    }
    if (updates.length) {
      await sheetsRequest(token, "POST", "/values:batchUpdate", {
        valueInputOption: "USER_ENTERED",
        data: updates,
      });
      log.push("✅ En-têtes et exemples écrits");
    }

    // Formatage : gras + couleur fond sur ligne 1 + freeze
    const formatRequests: unknown[] = [];
    for (const s of SHEETS_CONFIG) {
      const sheetId = allSheets.get(s.title);
      if (sheetId === undefined) continue;
      formatRequests.push(
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: s.color,
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        }
      );
    }
    if (formatRequests.length) {
      await sheetsRequest(token, "POST", ":batchUpdate", { requests: formatRequests });
      log.push("✅ Formatage appliqué");
    }

    log.push(`\n🎉 Setup terminé — ${SHEETS_CONFIG.length} onglets configurés`);
    return new Response(JSON.stringify({ ok: true, log }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    log.push(`❌ Erreur : ${e}`);
    return new Response(JSON.stringify({ ok: false, log, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
