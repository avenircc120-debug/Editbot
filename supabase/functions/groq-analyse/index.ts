// groq-analyse/index.ts — COMPETITIONS (Sheets, API key) → ESPN → Groq → Supabase DB
// POST /functions/v1/groq-analyse  Body: { competition_id?, marche? }

import { sheetsGet } from "../_shared/sheets-client.ts";

const GROQ_KEY  = Deno.env.get("GROQ_API_KEY")              ?? "";
const SB_URL    = Deno.env.get("SUPABASE_URL")               ?? "";
const SB_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")  ?? "";
const SHEETS_ID = Deno.env.get("GOOGLE_SHEETS_ID")           ?? "";

// ── ESPN ─────────────────────────────────────────────────────────────────────
async function getESPNMatches(league: string): Promise<unknown[]> {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json() as { events?: unknown[] };
    return j.events ?? [];
  } catch { return []; }
}

// ── Groq ─────────────────────────────────────────────────────────────────────
interface AnalyseResult {
  prediction: string;
  confiance: number;
  action: string;
  detail: string;
}

async function analyseWithGroq(
  competition: string,
  matchDesc: string,
  marche: string,
  context: string,
): Promise<AnalyseResult | null> {
  const prompt = `Tu es un analyste football expert. Analyse ce match et donne une prédiction.

Compétition : ${competition}
Match       : ${matchDesc}
Marché      : ${marche}
Contexte ESPN: ${context}

Réponds UNIQUEMENT avec ce JSON (sans markdown) :
{
  "prediction": "<résultat prédit ex: Victoire Domicile>",
  "confiance": <entier 0-100>,
  "action": "<JOUER ou NE PAS JOUER>",
  "detail": "<analyse courte 2-3 phrases>"
}`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:       "llama-3.3-70b-versatile",
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens:  300,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j    = await r.json() as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    // Nettoyer les blocs markdown si Groq en ajoute
    const clean = text.replace(/^```(?:json)?|```$/gm, "").trim();
    const json  = JSON.parse(clean) as Partial<AnalyseResult & { confiance: number }>;
    return {
      prediction: String(json.prediction ?? ""),
      confiance:  Math.min(100, Math.max(0, Number(json.confiance) || 0)),
      action:     json.action === "JOUER" ? "JOUER" : "NE PAS JOUER",
      detail:     String(json.detail ?? ""),
    };
  } catch { return null; }
}

// ── Supabase insert ───────────────────────────────────────────────────────────
async function insertAnalyse(row: Record<string, unknown>) {
  await fetch(`${SB_URL}/rest/v1/analyse_ia_groq`, {
    method: "POST",
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405 });

  const body     = await req.json().catch(() => ({})) as { competition_id?: string; marche?: string };
  const filterId = body.competition_id;
  const marche   = body.marche || "1X2";

  // Lire COMPETITIONS depuis Google Sheets (lecture seule, API key)
  // Colonnes : A=ID | B=Nom | C=ESPN_League_ID | D=Actif(OUI/NON) | E=Priorité | F=Marché_Defaut
  let competitions: string[][] = [];
  try {
    competitions = await sheetsGet("COMPETITIONS!A2:F100", SHEETS_ID);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Impossible de lire COMPETITIONS", detail: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const actives = competitions
    .filter(r => r[3]?.toUpperCase() === "OUI" && (!filterId || r[0] === filterId))
    .sort((a, b) => Number(a[4] ?? 99) - Number(b[4] ?? 99));

  if (!actives.length)
    return new Response(
      JSON.stringify({ ok: true, traites: 0, message: "Aucune compétition active" }),
      { headers: { "Content-Type": "application/json" } }
    );

  let total = 0;
  for (const comp of actives) {
    const [, compNom, leagueId, , , marcheDefaut] = comp;
    const marcheCible = marche || marcheDefaut || "1X2";
    const events      = await getESPNMatches(leagueId);

    for (const ev of (events as Record<string, unknown>[]).slice(0, 5)) {
      const matchDesc = String(ev["name"] ?? ev["shortName"] ?? "Match inconnu");
      const comps     = (ev["competitions"] as { competitors?: { team?: { abbreviation?: string }; score?: string }[]; venue?: { fullName?: string } }[])?.[0];
      const context   = JSON.stringify({
        statut: (ev["status"] as { type?: { description?: string } })?.type?.description,
        score:  comps?.competitors?.map(c => `${c.team?.abbreviation ?? ""} ${c.score ?? ""}`).join(" vs "),
        stade:  comps?.venue?.fullName,
        date:   ev["date"],
      });

      const analyse = await analyseWithGroq(compNom, matchDesc, marcheCible, context);
      if (!analyse) continue;

      await insertAnalyse({
        competition:  compNom,
        match_desc:   matchDesc,
        marche:       marcheCible,
        analyse_groq: analyse.detail,
        prediction:   analyse.prediction,
        confiance:    analyse.confiance,
        action:       analyse.action,
        envoye:       false,
      });
      total++;
      await new Promise(r => setTimeout(r, 800));
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  return new Response(
    JSON.stringify({ ok: true, traites: total, competitions: actives.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});
