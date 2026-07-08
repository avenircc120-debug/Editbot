// web-search/index.ts — Phase 2 : Collecte + Vectorisation
// 1. Google Custom Search  2. Embedding text-embedding-004  3. raw_web_data

import { embed, toSqlVector } from "../_shared/embed.ts";

const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const GOOGLE_CSE_ID  = Deno.env.get("GOOGLE_CSE_ID")  ?? "";
const SB_URL         = Deno.env.get("SUPABASE_URL")    ?? "";
const SB_KEY         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TIMEOUT_MS     = 15_000;

interface SearchResult { title: string; link: string; snippet: string; }

async function googleSearch(query: string, num: number): Promise<SearchResult[]> {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) throw new Error("GOOGLE_API_KEY ou GOOGLE_CSE_ID manquant");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://www.googleapis.com/customsearch/v1?` +
      new URLSearchParams({ key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query, num: String(num) });
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`CSE ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return (data.items ?? []).map((i: any) => ({ title: i.title ?? "", link: i.link ?? "", snippet: i.snippet ?? "" }));
  } finally {
    clearTimeout(t);
  }
}

async function storeResult(query: string, item: SearchResult, vec: number[] | null) {
  const row: Record<string, unknown> = {
    query, title: item.title, snippet: item.snippet, source_url: item.link,
    content: `${item.title}\n${item.snippet}`, processed: false,
  };
  if (vec) row.embedding = toSqlVector(vec);
  const r = await fetch(`${SB_URL}/rest/v1/raw_web_data`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Prefer": "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${await r.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
  try {
    const { query, num = 8 } = await req.json();
    if (!query?.trim()) return new Response(JSON.stringify({ error: "query requis" }), { status: 400 });

    const results = await googleSearch(query.trim(), Math.min(num, 10));
    if (!results.length) return new Response(JSON.stringify({ ok: true, stored: 0, message: "Aucun résultat CSE" }), { headers: { "Content-Type": "application/json" } });

    // Vectorisation + stockage parallèle avec gestion individuelle des erreurs
    const outcomes = await Promise.allSettled(results.map(async (item) => {
      const vec = await embed(`${item.title} ${item.snippet}`);
      await storeResult(query.trim(), item, vec);
    }));
    const stored = outcomes.filter(o => o.status === "fulfilled").length;
    const errors = outcomes.filter(o => o.status === "rejected").map(o => (o as PromiseRejectedResult).reason?.message);
    if (errors.length) console.warn(`[web-search] ${errors.length} erreurs:`, errors);

    console.log(`[web-search] ${stored}/${results.length} stockés pour "${query}"`);
    return new Response(JSON.stringify({ ok: true, query, stored, titles: results.map(r => r.title) }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[web-search]", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
