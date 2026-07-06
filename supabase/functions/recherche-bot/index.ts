// ═══════════════════════════════════════════════════════════════════
    //  RECHERCHE-BOT v2 — API Keys uniquement (pas de JSON Service Account)
    //
    //  Secrets requis :
    //    GOOGLE_API_KEY      → Custom Search API  (URL param ?key=)
    //    GOOGLE_CSE_ID       → ID du moteur Custom Search
    //    GOOGLE_SHEETS_KEY   → Sheets API key     (URL param ?key=)
    //    GOOGLE_SHEETS_ID    → ID de la Google Sheet
    //    SUPABASE_URL        → auto-injecté par Supabase
    //    SUPABASE_SERVICE_ROLE_KEY → auto-injecté par Supabase
    //
    //  Prérequis Sheets : partager la Sheet en "Éditeur — Toute personne
    //  avec le lien" pour que l'API Key ait les droits en écriture.
    //
    //  POST { query: string }  →  { results[], inserted, total_results }
    // ═══════════════════════════════════════════════════════════════════

    const GOOGLE_API_KEY  = Deno.env.get("GOOGLE_API_KEY")              ?? "";
    const GOOGLE_CSE_ID   = Deno.env.get("GOOGLE_CSE_ID")               ?? "";
    const SHEETS_KEY      = Deno.env.get("GOOGLE_SHEETS_KEY")           ?? "";
    const SHEETS_ID       = Deno.env.get("GOOGLE_SHEETS_ID")            ?? "";
    const SB_URL          = Deno.env.get("SUPABASE_URL")                ?? "";
    const SB_KEY          = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")   ?? "";

    const SHEETS_TAB = "Recherches"; // Onglet cible — créer l'onglet s'il n'existe pas

    // ── Colonnes de l'onglet Recherches ──────────────────────────────
    // A: date_heure | B: query | C: title | D: link | E: snippet | F: displayLink

    // ── 1. Google Custom Search ───────────────────────────────────────
    interface SearchItem {
    title:       string;
    link:        string;
    snippet:     string;
    displayLink: string;
    }

    async function googleSearch(
    query: string,
    num = 10
    ): Promise<{ items: SearchItem[]; total: number }> {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", GOOGLE_API_KEY);
    url.searchParams.set("cx",  GOOGLE_CSE_ID);
    url.searchParams.set("q",   query);
    url.searchParams.set("num", String(Math.min(num, 10)));

    const r = await fetch(url.toString());
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Custom Search ${r.status}: ${err}`);
    }
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

    // ── 2. Google Sheets — APPEND via API Key ─────────────────────────
    // Nécessite : Sheet partagée "Toute personne avec le lien → Éditeur"
    async function appendSheets(query: string, items: SearchItem[]): Promise<void> {
    const now    = new Date().toISOString();
    const values = items.map(i => [
      now,
      query,
      i.title,
      i.link,
      i.snippet,
      i.displayLink,
    ]);

    const range = `${SHEETS_TAB}!A:F`;
    const url   =
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}` +
      `/values/${encodeURIComponent(range)}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS&key=${SHEETS_KEY}`;

    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ values }),
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Sheets append ${r.status}: ${err}`);
    }
    }

    // ── 3. Supabase INSERT → table recherches_bot ─────────────────────
    async function insertSupabase(
    query:   string,
    results: SearchItem[],
    total:   number
    ): Promise<void> {
    const r = await fetch(`${SB_URL}/rest/v1/recherches_bot`, {
      method:  "POST",
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "return=minimal",
      },
      body: JSON.stringify({ query, total_results: total, results }),
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Supabase insert ${r.status}: ${err}`);
    }
    }

    // ── Handler principal ─────────────────────────────────────────────
    Deno.serve(async (req) => {
    // Healthcheck
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok", fn: "recherche-bot", version: "2.0" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Parse body
    let query: string;
    try {
      const body = await req.json();
      query = (body?.query ?? "").trim();
      if (!query) throw new Error("Champ 'query' requis");
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      // Étape 1 — Recherche Google
      const { items, total } = await googleSearch(query);

      // Étape 2 — Stockage parallèle (Supabase + Sheets)
      const [, sheetsErr] = await Promise.allSettled([
        insertSupabase(query, items, total),
        appendSheets(query, items),
      ]).then(results => results.map(r =>
        r.status === "rejected" ? (console.error("Storage error:", r.reason), r.reason) : null
      ));

      return new Response(
        JSON.stringify({
          query,
          total_results: total,
          inserted:      items.length,
          results:       items,
          sheets_ok:     !sheetsErr,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("recherche-bot:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    });
    