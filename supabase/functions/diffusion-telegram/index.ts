// diffusion-telegram/index.ts — ANALYSE_IA_GROQ (Confiance ≥ seuil) → Telegram
// POST /functions/v1/diffusion-telegram  Body: { seuil_confiance?, channel_id, dry_run? }
import { sheetsGet, sheetsUpdateCell } from "../_shared/sheets-client.ts";

const TG_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SHEETS_ID = Deno.env.get("GOOGLE_SHEETS_ID")   ?? "";
const TG_BASE   = `https://api.telegram.org/bot${TG_TOKEN}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadTemplates(): Promise<Map<string, string>> {
  const rows = await sheetsGet(SHEETS_ID, "TEMPLATES!A2:F100");
  const map = new Map<string, string>();
  for (const r of rows) if (r[5] === "true") map.set(r[1], r[3]);
  return map;
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

async function sendTG(chatId: string, text: string): Promise<boolean> {
  const r = await fetch(`${TG_BASE}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  return (await r.json()).ok === true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST uniquement", { status: 405 });
  if (!SHEETS_ID || !TG_TOKEN) return new Response(JSON.stringify({ ok: false, error: "Secrets manquants" }), { status: 500 });
  const body = await req.json().catch(() => ({}));
  const { seuil_confiance = 80, channel_id, dry_run = false } = body;
  if (!channel_id && !dry_run) return new Response(JSON.stringify({ ok: false, error: "channel_id requis" }), { status: 400 });
  const log: string[] = [];
  let sent = 0;
  try {
    const [templates, rows] = await Promise.all([
      loadTemplates(),
      sheetsGet(SHEETS_ID, "ANALYSE_IA_GROQ!A2:I1000"),
    ]);
    log.push(`📋 ${templates.size} template(s) | 📊 ${rows.length} lignes ANALYSE_IA_GROQ`);
    const eligible = rows.map((r, i) => ({ row: r, idx: i + 2 }))
      .filter(({ row }) => row[8] !== "true" && parseInt(row[6] ?? "0") >= seuil_confiance && row[7] === "JOUER");
    log.push(`🎯 ${eligible.length} éligible(s) (confiance ≥ ${seuil_confiance}%)`);
    const tpl = templates.get("match_a_venir") ?? templates.get("analyse_complete") ?? "{competition}\n{match}\n{prediction} ({confiance}%)";
    for (const { row, idx } of eligible) {
      const [ts, competition, match, marche, analyse, prediction, confiance, action] = row;
      const vars: Record<string, string> = {
        timestamp: ts, competition, match, marche_cible: marche, marche,
        analyse_groq: analyse, prediction, confiance, action,
        equipe_dom: match.split(" vs ")[0]?.trim() ?? match,
        equipe_ext: match.split(" vs ")[1]?.trim() ?? "",
        date_match: ts.split("T")[0] ?? "", heure: ts.split("T")[1]?.slice(0, 5) ?? "",
        cote: "—", forme_dom: "—", forme_ext: "—", moy_dom: "—", moy_ext: "—",
      };
      const message = render(tpl, vars);
      log.push(`📤 [${idx}] ${competition} — ${match} (${confiance}%)`);
      if (!dry_run) {
        if (await sendTG(channel_id, message)) {
          sent++;
          await sheetsUpdateCell(SHEETS_ID, `ANALYSE_IA_GROQ!I${idx}`, "true");
        } else log.push(`  ❌ Échec ligne ${idx}`);
        await sleep(500);
      } else { log.push(`  [DRY RUN] ${message.slice(0, 80)}…`); sent++; }
    }
    if (!eligible.length) log.push(`ℹ️ Rien à envoyer (seuil ${seuil_confiance}% non atteint)`);
    return new Response(JSON.stringify({ ok: true, sent, dry_run, log }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), log }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});