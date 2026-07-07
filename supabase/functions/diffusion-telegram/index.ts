// diffusion-telegram/index.ts — Supabase DB (confiance ≥ seuil) → Telegram
// POST /functions/v1/diffusion-telegram  Body: { channel_id, seuil_confiance?, dry_run? }

import { sheetsGet } from "../_shared/sheets-client.ts";

const TG_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")       ?? "";
const SB_URL    = Deno.env.get("SUPABASE_URL")              ?? "";
const SB_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHEETS_ID = Deno.env.get("GOOGLE_SHEETS_ID")          ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AnalyseRow {
  id: number;
  competition: string;
  match_desc: string;
  marche: string;
  prediction: string;
  confiance: number;
  action: string;
  analyse_groq: string;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function fetchAnalyses(seuil: number): Promise<AnalyseRow[]> {
  const url = `${SB_URL}/rest/v1/analyse_ia_groq`
    + `?confiance=gte.${seuil}&action=eq.JOUER&envoye=eq.false`
    + `&order=confiance.desc&limit=20`;
  const r = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase fetch → ${r.status}: ${await r.text()}`);
  return r.json() as Promise<AnalyseRow[]>;
}

async function markSent(id: number) {
  await fetch(`${SB_URL}/rest/v1/analyse_ia_groq?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=minimal",
    },
    body: JSON.stringify({ envoye: true }),
  });
}

async function logPrediction(row: AnalyseRow) {
  await fetch(`${SB_URL}/rest/v1/logs_predictions`, {
    method: "POST",
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=minimal",
    },
    body: JSON.stringify({
      competition:     row.competition,
      match_desc:      row.match_desc,
      marche:          row.marche,
      prediction:      row.prediction,
      confiance:       row.confiance,
      action:          row.action,
      envoye_telegram: true,
    }),
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  return r.ok;
}

// ── Template ──────────────────────────────────────────────────────────────────
// TEMPLATES!A:C — colonnes : Type | Nom | Contenu
async function getTemplate(type: string): Promise<string> {
  try {
    const rows = await sheetsGet("TEMPLATES!A2:C20", SHEETS_ID);
    const row  = rows.find(r => r[0]?.toLowerCase() === type.toLowerCase());
    return row?.[2] ?? buildDefaultTemplate();
  } catch { return buildDefaultTemplate(); }
}

function buildDefaultTemplate(): string {
  return [
    "🎯 *{competition}*",
    "⚽ {match}",
    "📊 Marché : {marche}",
    "🔮 Prédiction : *{prediction}*",
    "💪 Confiance : {confiance}%",
    "✅ Action : {action}",
    "📝 {analyse}",
  ].join("\n");
}

function applyTemplate(tpl: string, data: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => data[k] ?? "");
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405 });

  const body    = await req.json().catch(() => ({})) as {
    channel_id?: string;
    seuil_confiance?: number;
    dry_run?: boolean;
  };
  const channel = body.channel_id ?? "";
  const seuil   = Number(body.seuil_confiance) || 80;
  const dryRun  = body.dry_run === true;

  if (!channel)
    return new Response(
      JSON.stringify({ error: "channel_id requis (ex: @mon_canal ou -100123456)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );

  let analyses: AnalyseRow[];
  try {
    analyses = await fetchAnalyses(seuil);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Erreur Supabase", detail: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!analyses.length)
    return new Response(
      JSON.stringify({ ok: true, envoyes: 0, message: `Aucune analyse ≥ ${seuil}% à envoyer` }),
      { headers: { "Content-Type": "application/json" } }
    );

  const tpl = await getTemplate("match_a_venir");
  let envoyes = 0;

  for (const a of analyses) {
    const texte = applyTemplate(tpl, {
      competition: a.competition   ?? "",
      match:       a.match_desc    ?? "",
      marche:      a.marche        ?? "",
      prediction:  a.prediction    ?? "",
      confiance:   String(a.confiance ?? ""),
      action:      a.action        ?? "",
      analyse:     a.analyse_groq  ?? "",
    });

    if (!dryRun) {
      const ok = await sendTelegram(channel, texte);
      if (ok) {
        await markSent(a.id);
        await logPrediction(a);
        envoyes++;
      }
    } else {
      envoyes++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return new Response(
    JSON.stringify({ ok: true, envoyes, total_eligible: analyses.length, dry_run: dryRun }),
    { headers: { "Content-Type": "application/json" } }
  );
});
