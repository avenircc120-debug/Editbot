// _shared/sa-auth.ts — Service Account JWT RS256 (Deno / Supabase Edge)
// Usage : import { getAccessToken } from "../_shared/sa-auth.ts";

let _cache: { token: string; expiresAt: number } | null = null;

function b64url(data: Uint8Array | string): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function getAccessToken(scopes: string[]): Promise<string> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.token;

  const SA_EMAIL  = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
  const SA_PEM    = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")   ?? "";

  if (!SA_EMAIL || !SA_PEM) {
    throw new Error(
      "SA non configuré : ajoutez GOOGLE_SERVICE_ACCOUNT_EMAIL et GOOGLE_SERVICE_ACCOUNT_KEY dans les secrets Supabase."
    );
  }

  const pemBody = SA_PEM
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss:   SA_EMAIL,
      scope: scopes.join(" "),
      aud:   "https://oauth2.googleapis.com/token",
      iat:   now,
      exp:   now + 3600,
    })
  );

  const sigInput = new TextEncoder().encode(`${header}.${payload}`);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, sigInput)
  );
  const jwt = `${header}.${payload}.${b64url(sigBytes)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant_type:jwt-bearer",
      assertion:  jwt,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token SA échoué : ${JSON.stringify(json)}`);
  }

  _cache = { token: json.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return _cache.token;
}