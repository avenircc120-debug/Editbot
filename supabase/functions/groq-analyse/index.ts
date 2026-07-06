// groq-analyse/index.ts — Pipeline : COMPETITIONS → ESPN → Groq → ANALYSE_IA_GROQ
// POST /functions/v1/groq-analyse  Body: { competition_id?, marche? }
import { sheetsGet, sheetsAppend } from "../_shared/sheets-client.ts";

const GROQ_KEY   = Deno.env.get("GROQ_API_KEY")     ?? "";
const SHEETS_ID  = Deno.env.get("GOOGLE_SHEETS_ID") ?? "";
const ESPN_BASE  = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Competition { id: string; nom: string; pays: string; url: string; priorite: number }
interface Match { homeTeam: string; awayTeam: string; date: string; status: string; homeScore?: number; awayScore?: number }
interface GroqAnalysis { match: string; marche: string; analyse: string; prediction: string; confiance: number; action: "JOUER" | "NE PAS JOUER" }

function extractSlug(url: string): string {
  const parts = url.split("/");
  const idx = parts.indexOf("soccer");
  return idx !== -1 && parts[idx + 1] ? parts[idx + 1] : "fra.1";
}

async function fetchMatches(comp: Competition): Promise<Match[]> {
  const slug  = extractSlug(comp.url);
  const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
  try {
    const r = await fetch(`${ESPN_BASE}/${slug}/scoreboard?dates=${today}&limit=20`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AnalyseBot/1.0)" },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.events ?? []).map((e: any) => {
      const c = e.competitions?.[0];
      const h = c?.competitors?.find((x: any) => x.homeAway === "home");
      const a = c?.competitors?.find((x: any) => x.homeAway === "away");
      return { homeTeam: h?.team?.displayName ?? "?", awayTeam: a?.team?.displayName ?? "?", date: e.date ?? "", status: c?.status?.type?.name ?? "STATUS_SCHEDULED", homeScore: parseInt(h?.score ?? "0"), awayScore: parseInt(a?.score ?? "0") };
    });
  } catch { return []; }
}

async function analyseMatch(competition: string, match: Match, marche: string): Promise<GroqAnalysis | null> {
  const prompt = `Tu es un expert en pronostics sportifs.
Compétition : ${competition}
Match : ${match.homeTeam} vs ${match.awayTeam}
Date : ${match.date}
Marché : ${marche}

Réponds UNIQUEMENT avec un objet JSON valide :
{"analyse":"résumé 2-3 phrases","prediction":"valeur prédite","confiance":75,"action":"JOUER"}
confiance : 0-100. action : "JOUER" si confiance >= 65 sinon "NE PAS JOUER"`;

  try {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.3, max_tokens: 512, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content ?? "{}";
    const p = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { match: `${match.homeTeam} vs ${match.awayTeam}`, marche, analyse: p.analyse ?? "", prediction: p.prediction ?? "", confiance: parseInt(p.confiance ?? "0"), action: p.action === "JOUER" ? "JOUER" : "NE PAS JOUER" };
  } catch { return null; }
}

async function writeStats(matches: Match[], competition: string): Promise<void> {
  const done = matches.filter((m) => m.status === "STATUS_FINAL");
  if (!done.length) return;
  const now = new Date().toISOString();
  const rows = done.map((m, i) => [`SH-${Date.now()}-${i}`, now, competition, m.homeTeam, m.awayTeam, String(m.homeScore ?? ""), String(m.awayScore ?? ""), "","","","","","","","","","","","","","ESPN","automatique"]);
  await sheetsAppend(SHEETS_ID, "STATS_HISTORIQUE!A:V", rows);
}

async function writeAnalyse(analyses: GroqAnalysis[], competition: string): Promise<number> {
  if (!analyses.length) return 0;
  const now = new Date().toISOString();
  const rows = analyses.map((a) => [now, competition, a.match, a.marche, a.analyse, a.prediction, String(a.confiance), a.action, "false"]);
  await sheetsAppend(SHEETS_ID, "ANALYSE_IA_GROQ!A:I", rows);
  return rows.length;
}

async function getActiveCompetitions(id?: string): Promise<Competition[]> {
  const rows = await sheetsGet(SHEETS_ID, "COMPETITIONS!A2:H100");
  return rows.filter((r) => r[5] === "true" && (!id || r[0] === id))
    .map((r) => ({ id: r[0], nom: r[1], pays: r[2], url: r[4], priorite: parseInt(r[6] ?? "9") }))
    .sort((a, b) => a.priorite - b.priorite);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST uniquement", { status: 405 });
  if (!SHEETS_ID) return new Response(JSON.stringify({ ok: false, error: "GOOGLE_SHEETS_ID manquant" }), { status: 500 });
  const body = await req.json().catch(() => ({}));
  const { competition_id, marche = "1X2" } = body;
  const log: string[] = [];
  let totalAnalyses = 0;
  try {
    const competitions = await getActiveCompetitions(competition_id);
    if (!competitions.length) return new Response(JSON.stringify({ ok: false, error: "Aucune compétition active" }), { status: 404 });
    log.push(`📋 ${competitions.length} compétition(s)`);
    for (const comp of competitions) {
      log.push(`🔍 ${comp.nom}`);
      const matches = await fetchMatches(comp);
      if (!matches.length) { log.push(`  ⚠️ Aucun match — ${comp.nom}`); continue; }
      await writeStats(matches, comp.nom);
      const aAnalyser = matches.filter((m) => m.status !== "STATUS_FINAL").slice(0, 5);
      if (!aAnalyser.length) { log.push(`  ℹ️ Pas de match à venir`); continue; }
      const analyses: GroqAnalysis[] = [];
      for (const match of aAnalyser) {
        const res = await analyseMatch(comp.nom, match, marche);
        if (res) { analyses.push(res); log.push(`  ✅ ${res.match} → ${res.prediction} (${res.confiance}%) ${res.action}`); }
        await sleep(800);
      }
      totalAnalyses += await writeAnalyse(analyses, comp.nom);
      await sleep(1200);
    }
    return new Response(JSON.stringify({ ok: true, total_analyses: totalAnalyses, log }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), log }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});