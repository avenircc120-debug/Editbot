// _shared/embed.ts — Génération d'embeddings via Google text-embedding-004
// Utilise GOOGLE_API_KEY (Gemini API, pas de WIF requis)
// Dimension : 768

const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const EMBED_MODEL    = "text-embedding-004";
const EMBED_URL      = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GOOGLE_API_KEY}`;

/**
 * Génère un vecteur 768d pour un texte donné.
 * Retourne null si l'API Key manque ou si l'appel échoue.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!GOOGLE_API_KEY) {
    console.warn("[embed] GOOGLE_API_KEY manquant");
    return null;
  }
  if (!text?.trim()) return null;

  try {
    const r = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: text.slice(0, 8192) }] },
        taskType: "RETRIEVAL_QUERY",
      }),
    });
    if (!r.ok) {
      console.error("[embed] API error:", r.status, await r.text());
      return null;
    }
    const data = await r.json();
    return data?.embedding?.values ?? null;
  } catch (e) {
    console.error("[embed] Exception:", e);
    return null;
  }
}

/**
 * Formate un vecteur pour insertion Supabase pgvector : '[0.1,0.2,...]'
 */
export function toSqlVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
