// telegram-agent/index.ts — Phase 4 : Interface Utilisateur
// ⚠️  Aucun appel Sheets pendant les conversations
// Priorité 1 : Cache sémantique Supabase (pgvector)
// Priorité 2 : Pipeline complet (web-search → groq-analyse)

import { embed, toSqlVector } from "../_shared/embed.ts";

const TG_TOKEN      = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_WH_SECRET  = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const GROQ_KEY      = Deno.env.get("GROQ_API_KEY") ?? "";
const SB_URL        = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FUNCTIONS_URL = Deno.env.get("SUPABASE_URL")?.replace("/rest/v1","")?.replace("https://","https://") ?? "";
// Utilise SUPABASE_URL pour dériver l'URL des fonctions (pas de ref codée en dur)
const fnBase = () => {
  const m = SB_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m ? `https://${m[1]}.supabase.co/functions/v1` : "";
};

const TG = `https://api.telegram.org/bot${TG_TOKEN}`;
const TIMEOUT_MS = 25_000;

const withTimeout = (p: Promise<Response>, ms = TIMEOUT_MS): Promise<Response> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return p.finally(() => clearTimeout(t));
};

const sbFetch = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, ...(init.headers ?? {}) },
  });

const sbRpc = (fn: string, params: Record<string, unknown>) =>
  fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
    body: JSON.stringify(params),
  });

async function tgSend(chatId: number, text: string) {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function tgTyping(chatId: number) {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ── Cache sémantique pgvector ─────────────────────────────────────
async function semanticSearch(query: string): Promise<string | null> {
  const vec = await embed(query);
  if (!vec) return null;
  const vecStr = toSqlVector(vec);

  const [analyseRes, knowledgeRes] = await Promise.all([
    sbRpc("search_analyses",  { query_embedding: vecStr, match_threshold: 0.78, match_count: 1 }),
    sbRpc("search_knowledge", { query_embedding: vecStr, match_threshold: 0.72, match_count: 1 }),
  ]);

  if (analyseRes.ok) {
    const rows = await analyseRes.json();
    if (rows?.length) {
      console.log(`[cache] Hit analyse_groq sim=${rows[0].similarity?.toFixed(3)}`);
      return rows[0].synthese;
    }
  }
  if (knowledgeRes.ok) {
    const rows = await knowledgeRes.json();
    if (rows?.length) {
      console.log(`[cache] Hit base_connaissance sim=${rows[0].similarity?.toFixed(3)}`);
      return rows[0].contenu;
    }
  }
  return null;
}

// ── Pipeline complet ──────────────────────────────────────────────
async function runPipeline(query: string): Promise<string> {
  const base = fnBase();
  if (!base) return await groqDirect(query);
  const hdrs = { "Content-Type": "application/json", "Authorization": `Bearer ${SB_KEY}` };

  try {
    const searchR = await withTimeout(fetch(`${base}/web-search`, {
      method: "POST", headers: hdrs, body: JSON.stringify({ query, num: 8 }),
    }), 20_000);
    if (!searchR.ok) throw new Error(`web-search ${searchR.status}`);
    const sd = await searchR.json();
    console.log(`[pipeline] web-search: ${sd.stored} résultats`);
  } catch (e) {
    console.error("[pipeline] web-search failed:", e);
    return await groqDirect(query);
  }

  try {
    const analyseR = await withTimeout(fetch(`${base}/groq-analyse`, {
      method: "POST", headers: hdrs, body: JSON.stringify({ query }),
    }), 25_000);
    if (!analyseR.ok) throw new Error(`groq-analyse ${analyseR.status}`);
    const ad = await analyseR.json();
    return ad.synthese ?? await groqDirect(query);
  } catch (e) {
    console.error("[pipeline] groq-analyse failed:", e);
    return await groqDirect(query);
  }
}

// ── Fallback Groq direct ──────────────────────────────────────────
async function groqDirect(query: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", temperature: 0.4, max_tokens: 512,
        messages: [
          { role: "system", content: "Tu es Editbot, expert football. Réponds en français de façon naturelle. Si données insuffisantes, indique-le." },
          { role: "user", content: query },
        ],
      }),
    });
    if (!r.ok) return "Désolé, service temporairement indisponible.";
    return (await r.json()).choices?.[0]?.message?.content ?? "Pas de réponse.";
  } catch {
    return "Désolé, le service est surchargé. Réessaie dans quelques secondes.";
  } finally {
    clearTimeout(t);
  }
}

// ── Gestion des messages ──────────────────────────────────────────
async function handleMessage(chatId: number, text: string) {
  const query = text.trim();
  if (!query) return;
  console.log(`[agent] Query="${query}" chat=${chatId}`);
  await tgTyping(chatId);

  const cached = await semanticSearch(query);
  if (cached) {
    console.log("[agent] Cache hit");
    await tgSend(chatId, cached);
    return;
  }

  console.log("[agent] Cache miss — pipeline");
  await tgTyping(chatId);
  const answer = await runPipeline(query);
  await tgSend(chatId, answer);
}

async function handleCommand(chatId: number, cmd: string) {
  switch (cmd.split("@")[0]) {
    case "/start":
      await tgSend(chatId, `⚽ *Editbot Football Intelligence*\n\nPose-moi n'importe quelle question sur le football :\n• Résultats et classements\n• Analyses tactiques\n• Statistiques de joueurs\n• Pronostics de matchs\n\n_Je cherche, j'analyse et je te réponds._`);
      break;
    case "/help":
      await tgSend(chatId, `*Comment utiliser Editbot ?*\n\nParle-moi normalement :\n→ "Qui a marqué hier en Ligue 1 ?"\n→ "Analyse la forme du PSG ce mois-ci"\n→ "Pronostic Real Madrid - Barça"\n\n_Pas besoin de commandes._`);
      break;
    default:
      await tgSend(chatId, "Commande inconnue. /help pour l'aide.");
  }
}

// ── Entry point ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK");

  // Vérification du secret Telegram webhook
  if (TG_WH_SECRET) {
    const incoming = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (incoming !== TG_WH_SECRET) {
      console.warn("[security] Webhook secret invalide");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const update = await req.json();
    const msg = update?.message ?? update?.edited_message;
    if (!msg?.chat?.id) return new Response("OK");

    const chatId: number = msg.chat.id;
    const text: string   = msg.text ?? "";

    if (text.startsWith("/")) await handleCommand(chatId, text);
    else await handleMessage(chatId, text);

    return new Response("OK");
  } catch (e) {
    console.error("[telegram-agent]", e);
    return new Response("Error", { status: 500 });
  }
});
