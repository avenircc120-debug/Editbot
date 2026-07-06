// ═══════════════════════════════════════════════════════════════════
    //  RECHERCHE-BOT v3 — Flux : Custom Search → Vertex AI → Supabase + Sheets
    //
    //  Secrets Supabase requis :
    //    GOOGLE_API_KEY        → Custom Search API key
    //    GOOGLE_CSE_ID         → ID du moteur Custom Search
    //    GOOGLE_VERTEX_API_KEY → Vertex AI / Gemini Embedding (text-embedding-004)
    //    GOOGLE_SHEETS_KEY     → Sheets API key
    //    GOOGLE_SHEETS_ID      → ID de la Google Sheet
    //    SUPABASE_URL          → auto-injecté
    //    SUPABASE_SERVICE_ROLE_KEY → auto-injecté
    //
    //  Prérequis Sheets : partager en "Éditeur — Toute personne avec le lien"
    //
    //  POST { query, num? }
    //  → { query, total_results, inserted, embedding_dim, sheets_ok, results[] }
    // ═══════════════════════════════════════════════════════════════════

    const GOOGLE_API_KEY   = Deno.env.get("GOOGLE_API_KEY")              ?? "";
    const GOOGLE_CSE_ID    = Deno.env.get("GOOGLE_CSE_ID")               ?? "";
    const VERTEX_KEY       = Deno.env.get("GOOGLE_VERTEX_API_KEY")       ?? "";
    const SHEETS_KEY       = Deno.env.get("GOOGLE_SHEETS_KEY")           ?? "";
    const SHEETS_ID        = Deno.env.get("GOOGLE_SHEETS_ID")            ?? "";
    const SB_URL           = Deno.env.get("SUPABASE_URL")                ?? "";
    const SB_KEY           = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")   ?? "";

    const SHEETS_TAB = "Recherches";
    // Colonnes : A=date | B=query | C=title | D=link | E=snippet | F=displayLink

    // ────────────────────────────────────────────────────────────────────
    //  TYPE
    // ────────────────────────────────────────────────────────────────────
    interface SearchItem {
    title:       string;
    link:        string;
    snippet:     string;
    displayLink: string;
    }

    // ────────────────────────────────────────────────────────────────────
    //  1. GOOGLE CUSTOM SEARCH  (API Key dans l'URL)
    // ────────────────────────────────────────────────────────────────────
    async function customSearch(
    query: string,
    num   = 10,
    ): Promise<{ items: SearchItem[]; total: number }> {
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

    // ────────────────────────────────────────────────────────────────────
    //  2. VERTEX AI — text-embedding-004  (API Key dans l'URL)
    //     Endpoint Gemini public, accepte API Key sans Service Account
    // ────────────────────────────────────────────────────────────────────
    async function embedQuery(text: string): Promise<number[] | null> {
    if (!VERTEX_KEY) return null;
    try {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        "text-embedding-004:embedContent?key=" + VERTEX_KEY;

      const r = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model:   "models/text-embedding-004",
          content: { parts: [{ text }] },
        }),
      });

      if (!r.ok) {
        console.warn("Vertex embedding " + r.status + ": " + await r.text());
        return null;
      }
      const d = await r.json();
      return d?.embedding?.values ?? null;
    } catch (e) {
      console.warn("Vertex embedding error:", e);
      return null;
    }
    }

    // ────────────────────────────────────────────────────────────────────
    //  3. SUPABASE INSERT → table recherches_bot
    // ────────────────────────────────────────────────────────────────────
    async function insertSupabase(
    query:     string,
    results:   SearchItem[],
    total:     number,
    embedding: number[] | null,
    ): Promise<void> {
    const payload: Record<string, unknown> = {
      query,
      total_results: total,
      results,
      source: "google_custom_search",
    };
    if (embedding) payload.embedding = embedding;

    const r = await fetch(SB_URL + "/rest/v1/recherches_bot", {
      method:  "POST",
      headers: {
        apikey:         SB_KEY,
        Authorization:  "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        Prefer:         "return=minimal",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("Supabase insert " + r.status + ": " + await r.text());
    }

    // ────────────────────────────────────────────────────────────────────
    //  4. GOOGLE SHEETS APPEND  (API Key dans l'URL)
    //     La Sheet doit être partagée "Éditeur — Toute personne avec lien"
    // ────────────────────────────────────────────────────────────────────
    async function appendSheets(query: string, items: SearchItem[]): Promise<void> {
    const now    = new Date().toISOString();
    const values = items.map(i => [
      now, query, i.title, i.link, i.snippet, i.displayLink,
    ]);

    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" + SHEETS_ID +
      "/values/" + encodeURIComponent(SHEETS_TAB + "!A:F") +
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&key=" + SHEETS_KEY;

    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ values }),
    });
    if (!r.ok) throw new Error("Sheets append " + r.status + ": " + await r.text());
    }

    // ────────────────────────────────────────────────────────────────────
    //  HANDLER PRINCIPAL
    // ────────────────────────────────────────────────────────────────────
    Deno.serve(async (req) => {
    // Health-check GET
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({
          status:   "ok",
          fn:       "recherche-bot",
          version:  "3.0",
          services: ["custom-search", "vertex-embedding", "supabase", "sheets"],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Parse body
    let query: string;
    let num:   number;
    try {
      const body = await req.json();
      query = (body?.query ?? "").trim();
      num   = Math.min(parseInt(body?.num ?? "10", 10) || 10, 10);
      if (!query) throw new Error("Champ 'query' requis");
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    try {
      // ── Étape 1 : Custom Search + Embedding en parallèle ──────────
      const [searchResult, embedding] = await Promise.all([
        customSearch(query, num),
        embedQuery(query),        // non-bloquant : null si clé absente ou erreur
      ]);
      const { items, total } = searchResult;

      // ── Étape 2 : Supabase + Sheets en parallèle ─────────────────
      const [sbResult, shResult] = await Promise.allSettled([
        insertSupabase(query, items, total, embedding),
        appendSheets(query, items),
      ]);

      const sbOk     = sbResult.status === "fulfilled";
      const sheetsOk = shResult.status === "fulfilled";
      if (!sbOk)     console.error("Supabase:", (sbResult as PromiseRejectedResult).reason);
      if (!sheetsOk) console.error("Sheets:",   (shResult as PromiseRejectedResult).reason);

      return new Response(
        JSON.stringify({
          query,
          total_results:  total,
          inserted:       items.length,
          embedding_dim:  embedding?.length ?? null,
          supabase_ok:    sbOk,
          sheets_ok:      sheetsOk,
          results:        items,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      console.error("recherche-bot v3:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    });
    