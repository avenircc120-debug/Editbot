// setup-sheets/index.ts — initialise la structure du Google Sheet "Cerveau"
// POST /functions/v1/setup-sheets  (appel unique, pas de JWT requis)

const SHEETS_KEY = Deno.env.get("GOOGLE_SHEETS_KEY")!;
const SHEET_ID   = Deno.env.get("GOOGLE_SHEETS_ID")!;
const BASE       = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

// ── helpers ──────────────────────────────────────────────────────────────────
async function api(path: string, method = "GET", body?: unknown) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${BASE}${path}${sep}key=${SHEETS_KEY}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function getExistingSheets(): Promise<{ title: string; sheetId: number }[]> {
  const meta = await api("");
  return (meta.sheets ?? []).map((s: any) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

async function ensureSheet(existing: { title: string; sheetId: number }[], title: string) {
  if (existing.find((s) => s.title === title)) return;
  await api(":batchUpdate", "POST", {
    requests: [{ addSheet: { properties: { title } } }],
  });
}

async function setHeaders(range: string, values: string[]) {
  await api(
    `/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    "PUT",
    { values: [values] }
  );
}

// ── définition des onglets ───────────────────────────────────────────────────
const TABS = {
  Compétitions: [
    "ID","Nom","Pays","Type","URL_Stats","Actif","Priorité","Dernière_MAJ"
  ],
  Templates: [
    "ID","Type","Contexte","Template","Variables","Actif"
  ],
  Scraping_Temp: [
    "ID","Date_Scraping","Competition","Match","Date_Match",
    "Score","Stats_JSON","Traité","Source_URL"
  ],
  Archive_Stats: [
    "ID","Date","Competition","Equipe_Dom","Equipe_Ext",
    "Score_Dom","Score_Ext","Possession_Dom","Possession_Ext",
    "Tirs_Dom","Tirs_Ext","Tirs_Cadrés_Dom","Tirs_Cadrés_Ext",
    "Corners_Dom","Corners_Ext","Fautes_Dom","Fautes_Ext",
    "Cote_Dom","Cote_Nul","Cote_Ext","Source","Fiabilité"
  ],
};

// ── templates par défaut ─────────────────────────────────────────────────────
const DEFAULT_TEMPLATES = [
  ["T001","match_a_venir","programmé",
   "⚽ {competition}\n🏟 {equipe_dom} vs {equipe_ext}\n📅 {date_match} à {heure}\n💡 Prédiction : {prediction} ({fiabilite}%)",
   "competition,equipe_dom,equipe_ext,date_match,heure,prediction,fiabilite","true"],
  ["T002","resultat","terminé",
   "✅ RÉSULTAT\n{equipe_dom} {score_dom} - {score_ext} {equipe_ext}\n📊 Possession : {possession_dom}% / {possession_ext}%",
   "equipe_dom,score_dom,score_ext,equipe_ext,possession_dom,possession_ext","true"],
  ["T003","alerte_cote","opportunité",
   "🚨 ALERTE COTE\n{equipe_dom} vs {equipe_ext}\n💰 Cote {type_cote} : {valeur_cote}\n📈 Value bet détecté !",
   "equipe_dom,equipe_ext,type_cote,valeur_cote","true"],
  ["T004","analyse","analyse_complete",
   "🧠 ANALYSE\n{competition} — {equipe_dom} vs {equipe_ext}\n📊 Forme dom : {forme_dom} | Forme ext : {forme_ext}\n⚽ Moy buts dom : {moy_buts_dom} | ext : {moy_buts_ext}\n🎯 Tip : {tip} @ {cote}",
   "competition,equipe_dom,equipe_ext,forme_dom,forme_ext,moy_buts_dom,moy_buts_ext,tip,cote","true"],
];

// ── compétitions par défaut ───────────────────────────────────────────────────
const DEFAULT_COMPETITIONS = [
  ["C001","Ligue 1","France","Ligue nationale","https://www.google.com/search?q=ligue1+resultats","true","1",""],
  ["C002","Premier League","Angleterre","Ligue nationale","https://www.google.com/search?q=premier+league+results","true","2",""],
  ["C003","La Liga","Espagne","Ligue nationale","https://www.google.com/search?q=la+liga+resultados","true","3",""],
  ["C004","Serie A","Italie","Ligue nationale","https://www.google.com/search?q=serie+a+risultati","true","4",""],
  ["C005","Bundesliga","Allemagne","Ligue nationale","https://www.google.com/search?q=bundesliga+ergebnisse","true","5",""],
  ["C006","Champions League","Europe","Coupe continentale","https://www.google.com/search?q=champions+league+results","true","1",""],
  ["C007","Coupe du Monde","Monde","Coupe mondiale","https://www.google.com/search?q=world+cup+results","false","1",""],
  ["C008","Ligue 2","France","Ligue nationale","https://www.google.com/search?q=ligue2+resultats","true","6",""],
];

// ── main ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Méthode non autorisée", { status: 405 });
  }

  try {
    const existing = await getExistingSheets();
    const log: string[] = [];

    // 1. Créer les onglets manquants
    for (const title of Object.keys(TABS)) {
      await ensureSheet(existing, title);
      log.push(`✅ Onglet '${title}' prêt`);
    }

    // 2. Écrire les headers
    for (const [title, headers] of Object.entries(TABS)) {
      await setHeaders(`${title}!A1`, headers);
      log.push(`📋 Headers '${title}' écrits`);
    }

    // 3. Pré-remplir Compétitions si vide
    const existingComps = await api(`/values/Compétitions!A2`);
    if (!existingComps.values?.length) {
      await api(
        `/values/${encodeURIComponent("Compétitions!A2")}?valueInputOption=RAW`,
        "PUT",
        { values: DEFAULT_COMPETITIONS }
      );
      log.push("⚽ Compétitions par défaut insérées (8)");
    }

    // 4. Pré-remplir Templates si vide
    const existingTpl = await api(`/values/Templates!A2`);
    if (!existingTpl.values?.length) {
      await api(
        `/values/${encodeURIComponent("Templates!A2")}?valueInputOption=RAW`,
        "PUT",
        { values: DEFAULT_TEMPLATES }
      );
      log.push("💬 Templates par défaut insérés (4)");
    }

    return new Response(
      JSON.stringify({ ok: true, log }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
