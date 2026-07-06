// recherche-bot/index.ts v4 — Pipeline complet : Scraping → Sheets → Archive
// POST /functions/v1/recherche-bot
// Body: { competition_id?: string, query?: string, archive?: boolean }

const GOOGLE_API_KEY    = Deno.env.get("GOOGLE_API_KEY")!;
const GOOGLE_CSE_ID     = Deno.env.get("GOOGLE_CSE_ID")!;
const VERTEX_API_KEY    = Deno.env.get("GOOGLE_VERTEX_API_KEY")!;
const SHEETS_KEY        = Deno.env.get("GOOGLE_SHEETS_KEY")!;
const SHEET_ID          = Deno.env.get("GOOGLE_SHEETS_ID")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BASE_SHEETS       = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

// ── Types ────────────────────────────────────────────────────────────────────
interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface MatchData {
  competition: string;
  match: string;
  date_match: string;
  score: string;
  stats_json: string;
  source_url: string;
}

// ── Sheets helper ─────────────────────────────────────────────────────────────
async function sheetsGet(range: string) {
  const r = await fetch(
    `${BASE_SHEETS}/values/${encodeURIComponent(range)}?key=${SHEETS_KEY}`
  );
  return r.json();
}

async function sheetsAppend(range: string, values: unknown[][]) {
  const r = await fetch(
    `${BASE_SHEETS}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&key=${SHEETS_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  return r.json();
}

async function sheetsClear(range: string) {
  await fetch(
    `${BASE_SHEETS}/values/${encodeURIComponent(range)}:clear?key=${SHEETS_KEY}`,
    { method: "POST" }
  );
}

// ── Supabase helper ───────────────────────────────────────────────────────────
async function supabaseInsert(table: string, rows: unknown[]) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  return r.ok;
}

// ── Step 1 : lire les compétitions actives depuis le Sheet ────────────────────
async function getActiveCompetitions(id?: string) {
  const data = await sheetsGet("Compétitions!A2:H100");
  const rows: string[][] = data.values ?? [];
  return rows
    .filter((r) => r[5] === "true" && (!id || r[0] === id))
    .map((r) => ({
      id: r[0], nom: r[1], pays: r[2], type: r[3],
      url: r[4], priorite: parseInt(r[6] || "9"),
    }))
    .sort((a, b) => a.priorite - b.priorite);
}

// ── Step 2 : Google Custom Search ────────────────────────────────────────────
async function customSearch(query: string): Promise<SearchResult[]> {
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=5`;
  const r = await fetch(url);
  const j = await r.json();
  return (j.items ?? []).map((i: any) => ({
    title: i.title,
    link: i.link,
    snippet: i.snippet,
  }));
}

// ── Step 3 : Vertex AI pour structurer les données brutes ─────────────────────
async function extractMatchData(
  snippets: SearchResult[],
  competition: string
): Promise<MatchData[]> {
  const prompt = `Tu es un assistant qui extrait des données de matchs de football à partir de snippets de recherche Google.
Compétition : ${competition}
Snippets :
${snippets.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\nURL: ${s.link}`).join("\n\n")}

Réponds UNIQUEMENT avec un tableau JSON valide de matchs trouvés, chaque objet ayant :
- match (string: "Equipe A vs Equipe B")
- date_match (string: ISO ou "aujourd'hui")
- score (string: "2-1" ou "" si pas encore joué)
- stats (object: { possession_dom, possession_ext, tirs_dom, tirs_ext } ou {})
- source_url (string)

Si aucun match n'est trouvé, retourne [].
`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${VERTEX_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    }
  );
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return parsed.map((m: any) => ({
      competition,
      match: m.match ?? "",
      date_match: m.date_match ?? "",
      score: m.score ?? "",
      stats_json: JSON.stringify(m.stats ?? {}),
      source_url: m.source_url ?? "",
    }));
  } catch {
    return [];
  }
}

// ── Step 4 : déposer dans Scraping_Temp (Sheet + Supabase) ───────────────────
async function storeInScraping(matches: MatchData[]) {
  if (!matches.length) return;
  const now = new Date().toISOString();
  const rows = matches.map((m, i) => [
    `SCR-${Date.now()}-${i}`,
    now,
    m.competition,
    m.match,
    m.date_match,
    m.score,
    m.stats_json,
    "false",
    m.source_url,
  ]);
  await Promise.all([
    sheetsAppend("Scraping_Temp!A:I", rows),
    supabaseInsert("scraping_temp", matches.map((m, i) => ({
      id: rows[i][0],
      date_scraping: now,
      competition: m.competition,
      match: m.match,
      date_match: m.date_match,
      score: m.score,
      stats_json: m.stats_json,
      traite: false,
      source_url: m.source_url,
    }))),
  ]);
  return rows.length;
}

// ── Step 5 : archiver les données traitées ────────────────────────────────────
async function archiveProcessed() {
  const data = await sheetsGet("Scraping_Temp!A2:I1000");
  const rows: string[][] = data.values ?? [];
  const toArchive = rows.filter((r) => r[7] === "false" && r[5] !== "");

  if (!toArchive.length) return { archived: 0 };

  const archiveRows = toArchive.map((r) => {
    const stats = (() => { try { return JSON.parse(r[6]); } catch { return {}; } })();
    return [
      r[0],                       // ID
      r[1],                       // Date
      r[2],                       // Competition
      r[3].split(" vs ")[0]?.trim() ?? "", // Equipe Dom
      r[3].split(" vs ")[1]?.trim() ?? "", // Equipe Ext
      r[5].split("-")[0]?.trim() ?? "",    // Score Dom
      r[5].split("-")[1]?.trim() ?? "",    // Score Ext
      stats.possession_dom ?? "", stats.possession_ext ?? "",
      stats.tirs_dom ?? "",       stats.tirs_ext ?? "",
      stats.tirs_cadres_dom ?? "", stats.tirs_cadres_ext ?? "",
      stats.corners_dom ?? "",    stats.corners_ext ?? "",
      stats.fautes_dom ?? "",     stats.fautes_ext ?? "",
      stats.cote_dom ?? "",       stats.cote_nul ?? "",
      stats.cote_ext ?? "",       r[8], // Source
      "scraping",                 // Fiabilité
    ];
  });

  await Promise.all([
    sheetsAppend("Archive_Stats!A:V", archiveRows),
    supabaseInsert("archive_stats", archiveRows.map((r) => ({
      id: r[0], date: r[1], competition: r[2],
      equipe_dom: r[3], equipe_ext: r[4],
      score_dom: r[5] || null, score_ext: r[6] || null,
      possession_dom: r[7] || null, possession_ext: r[8] || null,
      tirs_dom: r[9] || null, tirs_ext: r[10] || null,
      source: r[21], fiabilite: r[22],
    }))),
  ]);

  // Marquer comme traité dans Scraping_Temp
  const indices = rows
    .map((r, i) => ({ traite: r[7], score: r[5], i }))
    .filter((x) => x.traite === "false" && x.score !== "")
    .map((x) => x.i + 2); // +2 car index 1-based + header

  for (const idx of indices) {
    await fetch(
      `${BASE_SHEETS}/values/${encodeURIComponent(`Scraping_Temp!H${idx}`)}?valueInputOption=RAW&key=${SHEETS_KEY}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [["true"]] }),
      }
    );
  }

  return { archived: archiveRows.length };
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Méthode non autorisée", { status: 405 });
  }

  const body = await req.json().catch(() => ({}));
  const { competition_id, query, archive = false } = body;

  try {
    // Mode archive uniquement
    if (archive) {
      const result = await archiveProcessed();
      return new Response(JSON.stringify({ ok: true, ...result }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Mode scraping complet
    const competitions = await getActiveCompetitions(competition_id);
    if (!competitions.length) {
      return new Response(JSON.stringify({ ok: false, error: "Aucune compétition active trouvée" }), {
        status: 404, headers: { "Content-Type": "application/json" },
      });
    }

    let totalStored = 0;
    const log: string[] = [];

    for (const comp of competitions) {
      const searchQuery = query ?? `${comp.nom} résultats matchs aujourd'hui`;
      log.push(`🔍 Recherche: ${searchQuery}`);

      const results = await customSearch(searchQuery);
      if (!results.length) { log.push(`⚠️ Aucun résultat pour ${comp.nom}`); continue; }

      const matches = await extractMatchData(results, comp.nom);
      if (!matches.length) { log.push(`⚠️ Aucun match extrait pour ${comp.nom}`); continue; }

      const stored = await storeInScraping(matches);
      totalStored += stored ?? 0;
      log.push(`✅ ${stored} match(s) stockés — ${comp.nom}`);

      // Anti-ban : délai entre compétitions
      await new Promise((r) => setTimeout(r, 1500));
    }

    return new Response(
      JSON.stringify({ ok: true, total_stored: totalStored, log }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
