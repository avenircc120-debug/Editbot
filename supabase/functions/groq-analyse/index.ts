// groq-analyse/index.ts — Phase 3 : Intelligence & Synthèse
// 1. Lit raw_web_data non traités  2. Groq synthétise  3. Stocke  4. Marque traités

import { embed, toSqlVector } from "../_shared/embed.ts";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL       = Deno.env.get("SUPABASE_URL")  ?? "";
const SB_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GROQ_MODEL   = "llama-3.3-70b-versatile";
const TIMEOUT_MS   = 20_000;

const sbFetch = (path: string, init: RequestInit) =>
  fetch(`${SB_URL}/rest/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, ...(init.headers ?? {}) },
  });

async function getRawData(query: string) {
  const r = await sbFetch(
    `/raw_web_data?query=eq.${encodeURIComponent(query)}&processed=eq.false&order=created_at.desc&limit=10`,
    { method: "GET" }
  );
  if (!r.ok) throw new Error(`Supabase read ${r.status}: ${await r.text()}`);
  return await r.json() as Array<{ id: string; title: string; snippet: string; source_url: string }>;
}

async function markProcessed(ids: string[]) {
  if (!ids.length) return;
  const r = await sbFetch(
    `/raw_web_data?id=in.(${ids.map(id => `"${id}"`).join(",")})`,
    { method: "PATCH", body: JSON.stringify({ processed: true }) }
  );
  if (!r.ok) console.error(`[groq-analyse] markProcessed ${r.status}: ${await r.text()}`);
}

async function groqSynthesize(query: string, context: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.3, max_tokens: 1024,
        messages: [
          { role: "system", content: "Tu es Editbot, expert football. Réponds en français, naturel et humanisé. Cite des chiffres précis. Si données insuffisantes, indique-le clairement." },
          { role: "user", content: `Question : ${query}\n\nDonnées collectées :\n${context}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    return (await r.json()).choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

async function storeAnalyse(query: string, synthese: string, sources: string[], vec: number[] | null): Promise<string> {
  const row: Record<string, unknown> = { query, synthese, sources };
  if (vec) row.embedding = toSqlVector(vec);
  const r = await sbFetch("/analyse_groq", {
    method: "POST", headers: { "Prefer": "return=representation" }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Insert analyse_groq ${r.status}: ${await r.text()}`);
  return (await r.json())[0]?.id ?? "";
}

async function storeKnowledge(query: string, synthese: string, vec: number[] | null) {
  const row: Record<string, unknown> = { sujet: query, contenu: synthese, tags: ["football", "analyse-ia"] };
  if (vec) row.embedding = toSqlVector(vec);
  const r = await sbFetch("/base_connaissance", {
    method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Insert base_connaissance ${r.status}: ${await r.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
  try {
    const { query } = await req.json().catch(() => ({ query: "" }));
    if (!query?.trim()) return new Response(JSON.stringify({ error: "query requis" }), { status: 400 });

    const rawItems = await getRawData(query.trim());
    if (!rawItems.length) return new Response(
      JSON.stringify({ ok: false, message: "Lance web-search d'abord", query }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );

    const context  = rawItems.map((item, i) => `[${i+1}] ${item.title}\n${item.snippet}\nSource : ${item.source_url}`).join("\n\n");
    const synthese = await groqSynthesize(query.trim(), context);
    if (!synthese) throw new Error("Groq n'a pas retourné de réponse");

    const vec     = await embed(synthese);
    const sources = rawItems.map(i => i.source_url).filter(Boolean);

    // Écriture atomique — les deux doivent réussir
    const [analyseId] = await Promise.all([
      storeAnalyse(query.trim(), synthese, sources, vec),
      storeKnowledge(query.trim(), synthese, vec),
    ]);

    // Marquer traités après succès des écritures
    await markProcessed(rawItems.map(i => i.id));

    console.log(`[groq-analyse] OK "${query}" (${rawItems.length} sources)`);
    return new Response(
      JSON.stringify({ ok: true, query, synthese, analyse_id: analyseId, sources_count: rawItems.length }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[groq-analyse]", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
