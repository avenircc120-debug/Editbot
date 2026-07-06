// ═══════════════════════════════════════════════════════════════════
    //  RECHERCHE-BOT v1 — Google Custom Search → Sheets + Supabase
    //  POST { query: string }  →  { results[], inserted, total_results }
    // ═══════════════════════════════════════════════════════════════════

    const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY")  ?? "";
    const GOOGLE_CSE_ID  = Deno.env.get("GOOGLE_CSE_ID")   ?? "";
    const SHEETS_ID      = Deno.env.get("GOOGLE_SHEETS_ID") ?? "";
    const SA_EMAIL       = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
    const SA_KEY_RAW     = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")   ?? "";
    const SB_URL         = Deno.env.get("SUPABASE_URL")                 ?? "";
    const SB_KEY         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")    ?? "";

    const SHEETS_TAB = "Recherches";

    // ── Service Account JWT RS256 ─────────────────────────────────────
    function b64url(data: Uint8Array | string): string {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let bin = "";
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }

    let _saToken: { token: string; expiresAt: number } | null = null;

    async function getSAToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (_saToken && _saToken.expiresAt > now + 60) return _saToken.token;

    const pemBody = SA_KEY_RAW
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8", der.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["sign"]
    );
    const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }));
    const sig = b64url(new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
        new TextEncoder().encode(header + "." + payload))
    ));
    const jwt = header + "." + payload + "." + sig;

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
    });
    const d = await r.json();
    if (!d.access_token) throw new Error("SA auth failed: " + JSON.stringify(d));
    _saToken = { token: d.access_token, expiresAt: now + (d.expires_in ?? 3600) };
    return _saToken.token;
    }

    // ── Google Custom Search ──────────────────────────────────────────
    interface SearchItem {
    title:       string;
    link:        string;
    snippet:     string;
    displayLink: string;
    }

    async function googleSearch(query: string, num = 10): Promise<{ items: SearchItem[]; total: number }> {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", GOOGLE_API_KEY);
    url.searchParams.set("cx",  GOOGLE_CSE_ID);
    url.searchParams.set("q",   query);
    url.searchParams.set("num", String(Math.min(num, 10)));

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error("Custom Search " + r.status + ": " + await r.text());
    const d = await r.json();
    return {
      items: (d.items ?? []).map((i: any) => ({
        title:       i.title       ?? "",
        link:        i.link        ?? "",
        snippet:     i.snippet     ?? "",
        displayLink: i.displayLink ?? "",
      })),
      total: parseInt(d.searchInformation?.totalResults ?? "0", 10),
    };
    }

    // ── Supabase INSERT → table recherches_bot ────────────────────────
    async function insertSupabase(query: string, results: SearchItem[], total: number): Promise<void> {
    const r = await fetch(SB_URL + "/rest/v1/recherches_bot", {
      method: "POST",
      headers: {
        apikey:         SB_KEY,
        Authorization:  "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        Prefer:         "return=minimal",
      },
      body: JSON.stringify({ query, total_results: total, results }),
    });
    if (!r.ok) throw new Error("Supabase insert " + r.status + ": " + await r.text());
    }

    // ── Google Sheets APPEND → onglet "Recherches" ───────────────────
    async function appendSheets(query: string, items: SearchItem[]): Promise<void> {
    const token  = await getSAToken();
    const now    = new Date().toISOString();
    const values = items.map(i => [now, query, i.title, i.link, i.snippet, i.displayLink]);
    const range  = SHEETS_TAB + "!A:F";
    const url    = "https://sheets.googleapis.com/v4/spreadsheets/" + SHEETS_ID +
                   "/values/" + encodeURIComponent(range) +
                   ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    if (!r.ok) throw new Error("Sheets append " + r.status + ": " + await r.text());
    }

    // ── Handler principal ─────────────────────────────────────────────
    Deno.serve(async (req) => {
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok", fn: "recherche-bot", version: "1.0" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let query: string;
    try {
      const body = await req.json();
      query = (body?.query ?? "").trim();
      if (!query) throw new Error("Champ 'query' requis");
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const { items, total } = await googleSearch(query);
      await Promise.all([
        insertSupabase(query, items, total),
        appendSheets(query, items),
      ]);
      return new Response(
        JSON.stringify({ query, total_results: total, inserted: items.length, results: items }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("recherche-bot:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    });
    