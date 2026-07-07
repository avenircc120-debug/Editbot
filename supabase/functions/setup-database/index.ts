// setup-database/index.ts — Initialise la config Supabase (Cerveau v2 — API key only)
// POST /functions/v1/setup-database
// Ne crée PAS de Google Sheet. Suppose que Base_Pronostics_Sportifs existe déjà
// et que son ID est dans GOOGLE_SHEETS_ID.

const SB_URL      = Deno.env.get("SUPABASE_URL")              ?? "";
const SB_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHEETS_KEY  = Deno.env.get("GOOGLE_SHEETS_KEY")         ?? "";
const SHEETS_ID   = Deno.env.get("GOOGLE_SHEETS_ID")          ?? "";

const DEFAUTS: Record<string, string> = {
  seuil_confiance: "80",
  marche_defaut:   "1X2",
  langue:          "fr",
  max_matchs:      "10",
};

async function upsertConfig(key: string, value: string) {
  const r = await fetch(`${SB_URL}/rest/v1/config_bot`, {
    method: "POST",
    headers: {
      apikey:          SB_KEY,
      Authorization:   `Bearer ${SB_KEY}`,
      "Content-Type":  "application/json",
      Prefer:          "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405 });

  if (!SHEETS_ID)
    return new Response(
      JSON.stringify({ error: "GOOGLE_SHEETS_ID non configuré dans les secrets Supabase" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );

  // Insérer la config par défaut dans Supabase
  const configResults: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(DEFAUTS)) {
    configResults[k] = await upsertConfig(k, v);
  }
  await upsertConfig("sheets_id", SHEETS_ID);

  // Vérifier l'accès en lecture au Google Sheet
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}?key=${SHEETS_KEY}`;
  const metaRes = await fetch(metaUrl);
  const meta    = metaRes.ok ? await metaRes.json() : null;
  const tabs    = meta?.sheets?.map((s: { properties: { title: string } }) => s.properties.title) ?? [];
  const tabsAttendus = ["COMPETITIONS", "STATS_HISTORIQUE", "TEMPLATES", "LOGS_PREDICTIONS", "ANALYSE_IA_GROQ"];
  const tabsManquants = tabsAttendus.filter(t => !tabs.includes(t));

  const avertissements: string[] = [];
  if (!metaRes.ok) {
    avertissements.push(
      `Impossible d'accéder au sheet (${metaRes.status}). ` +
      "Vérifiez que GOOGLE_SHEETS_KEY est valide et que le sheet est partagé en lecture publique."
    );
  }
  if (tabsManquants.length) {
    avertissements.push(`Onglets manquants dans le sheet : ${tabsManquants.join(", ")}`);
  }

  return new Response(
    JSON.stringify({
      ok:               true,
      sheets_id:        SHEETS_ID,
      acces_sheet:      metaRes.ok,
      tabs_detectes:    tabs,
      tabs_manquants:   tabsManquants,
      config_inseree:   Object.keys(DEFAUTS),
      avertissements,
      message:          avertissements.length === 0
        ? "✅ Tout est prêt. Lancez /groq-analyse pour démarrer le pipeline."
        : "⚠️ Configuration partielle — voir avertissements.",
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
