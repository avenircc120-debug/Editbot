// _shared/wif-auth.ts — Workload Identity Federation (sans JSON Service Account)
// Flux : JWT signé RSA → Google STS token exchange → SA impersonation → access token
// Aucune clé JSON Google requise. Stocke uniquement GOOGLE_WIF_SIGNING_KEY (PEM).

// ── Constantes ────────────────────────────────────────────────────────────────
const SUPABASE_REF  = "jxrwgcsbomqvvchvkkdt";
const JWKS_ISSUER   = `https://${SUPABASE_REF}.supabase.co/functions/v1/jwks`;
const KID           = "editbot-wif-key-1";
const STS_URL       = "https://sts.googleapis.com/v1/token";
const IAM_SA_BASE   = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";

const WIF_AUDIENCE  = Deno.env.get("GOOGLE_WIF_AUDIENCE")          ?? "";
const SA_EMAIL      = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const PEM_KEY       = Deno.env.get("GOOGLE_WIF_SIGNING_KEY")       ?? "";

// ── Cache token (durée de vie: 55 min) ────────────────────────────────────────
let _cache: { token: string; expiresAt: number } | null = null;

// ── Helpers PEM → CryptoKey ───────────────────────────────────────────────────
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function loadSigningKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(PEM_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ── Génération JWT RS256 ───────────────────────────────────────────────────────
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function createSubjectJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify({
    iss: JWKS_ISSUER,
    sub: "editbot-edge-function",
    aud: WIF_AUDIENCE,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const key      = await loadSigningKey();
  const sig      = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// ── Échange STS ────────────────────────────────────────────────────────────────
async function exchangeForFederatedToken(subjectJwt: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type:            "urn:ietf:params:oauth:grant-type:token-exchange",
    audience:              WIF_AUDIENCE,
    scope:                 "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type:  "urn:ietf:params:oauth:token-type:access_token",
    subject_token:         subjectJwt,
    subject_token_type:    "urn:ietf:params:oauth:token-type:jwt",
  });
  const r = await fetch(STS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`STS exchange failed ${r.status}: ${err}`);
  }
  const j = await r.json() as { access_token: string };
  return j.access_token;
}

// ── Impersonation SA → token Sheets ───────────────────────────────────────────
async function impersonateSA(federatedToken: string): Promise<string> {
  const url = `${IAM_SA_BASE}/${SA_EMAIL}:generateAccessToken`;
  const r   = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${federatedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      scope: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
      ],
      lifetime: "3600s",
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`SA impersonation failed ${r.status}: ${err}`);
  }
  const j = await r.json() as { accessToken: string };
  return j.accessToken;
}

// ── Export principal ───────────────────────────────────────────────────────────
/** Retourne un access token Google valide pour Sheets + Drive.
 *  Le token est mis en cache 55 min pour éviter les appels STS répétés. */
export async function getWIFToken(): Promise<string> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now + 60_000) return _cache.token;

  if (!WIF_AUDIENCE)
    throw new Error("GOOGLE_WIF_AUDIENCE non configuré. Voir guide WIF.");
  if (!SA_EMAIL)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL non configuré.");
  if (!PEM_KEY)
    throw new Error("GOOGLE_WIF_SIGNING_KEY non configuré.");

  const subjectJwt    = await createSubjectJwt();
  const federatedTok  = await exchangeForFederatedToken(subjectJwt);
  const accessToken   = await impersonateSA(federatedTok);

  _cache = { token: accessToken, expiresAt: now + 55 * 60 * 1000 };
  return accessToken;
}
