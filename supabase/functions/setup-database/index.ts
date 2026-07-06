// setup-database/index.ts — Initialise le "Cerveau" Google Sheets
// POST /functions/v1/setup-database
import { findSheetByName, createSheet, sheetsGet, sheetsPut, sheetsAppend, getSheetMeta, ensureTab } from "../_shared/sheets-client.ts";

const SHEET_NAME = "Base_Pronostics_Sportifs";
const SB_URL     = Deno.env.get("SUPABASE_URL")              ?? "";
const SB_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TABS: Record<string, string[]> = {
  COMPETITIONS:     ["ID","Nom","Pays","Type","URL_Stats","Actif","Priorité","Dernière_MAJ"],
  STATS_HISTORIQUE: ["ID","Date","Competition","Equipe_Dom","Equipe_Ext","Score_Dom","Score_Ext","Possession_Dom","Possession_Ext","Tirs_Dom","Tirs_Ext","Tirs_Cadrés_Dom","Tirs_Cadrés_Ext","Corners_Dom","Corners_Ext","Fautes_Dom","Fautes_Ext","Cote_Dom","Cote_Nul","Cote_Ext","Source","Fiabilité"],
  TEMPLATES:        ["ID","Type","Contexte","Template","Variables","Actif"],
  LOGS_PREDICTIONS: ["ID","Date","Competition","Match","Marché","Prédiction","Confiance","Action","Résultat_Réel","ROI","Envoyé_Telegram"],
  ANALYSE_IA_GROQ:  ["Timestamp","Competition","Match","Marché_Cible","Analyse_Groq","Prediction","Confiance","Action","Envoyé"],
};

const DEFAULT_COMPETITIONS = [
  ["C001","Ligue 1","France","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard","true","1",""],
  ["C002","Premier League","Angleterre","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard","true","2",""],
  ["C003","La Liga","Espagne","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard","true","3",""],
  ["C004","Serie A","Italie","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard","true","4",""],
  ["C005","Bundesliga","Allemagne","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard","true","5",""],
  ["C006","Champions League","Europe","Coupe continentale","https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard","true","1",""],
  ["C007","Europa League","Europe","Coupe continentale","https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard","true","6",""],
  ["C008","Ligue 2","France","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/scoreboard","true","7",""],
  ["C009","Eredivisie","Pays-Bas","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard","false","8",""],
  ["C010","MLS","USA","Ligue nationale","https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard","false","9",""],
];

const DEFAULT_TEMPLATES = [
  ["T001","match_a_venir","programmé","⚽ *{competition}*\n🏟 {equipe_dom} 🆚 {equipe_ext}\n📅 {date_match} à {heure}\n\n💡 *Prédiction :* {prediction}\n📊 *Marché :* {marche}\n🎯 *Confiance :* {confiance}%\n✅ *Action :* {action}","competition,equipe_dom,equipe_ext,date_match,heure,prediction,marche,confiance,action","true"],
  ["T002","resultat","terminé","✅ *RÉSULTAT — {competition}*\n{equipe_dom} {score_dom} - {score_ext} {equipe_ext}\n\n📊 Possession : {poss_dom}% / {poss_ext}%\n🎯 Tirs : {tirs_dom} / {tirs_ext}","competition,equipe_dom,score_dom,score_ext,equipe_ext,poss_dom,poss_ext,tirs_dom,tirs_ext","true"],
  ["T003","alerte_cote","opportunité","🚨 *ALERTE VALUE BET*\n{equipe_dom} vs {equipe_ext}\n💰 Cote {type_cote} : *{valeur_cote}*\n📈 Value bet — Confiance {confiance}%\n✅ Action : *JOUER*","equipe_dom,equipe_ext,type_cote,valeur_cote,confiance","true"],
  ["T004","analyse_complete","analyse","🧠 *ANALYSE GROQ — {competition}*\n{equipe_dom} vs {equipe_ext}\n\n{analyse_groq}\n\n🎯 *Tip :* {prediction}\n📈 Confiance : {confiance}% — {action}","competition,equipe_dom,equipe_ext,analyse_groq,prediction,confiance,action","true"],
];

async function saveSheetId(sheetId: string): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  await fetch(`${SB_URL}/rest/v1/config_bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: "GOOGLE_SHEETS_ID", value: sheetId }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST uniquement", { status: 405 });
  const log: string[] = [];
  try {
    let sheetId = await findSheetByName(SHEET_NAME);
    if (sheetId) {
      log.push(`📄 Sheet existant : ${sheetId}`);
    } else {
      sheetId = await createSheet(SHEET_NAME);
      log.push(`✨ Sheet créé : '${SHEET_NAME}' (ID: ${sheetId})`);
      await saveSheetId(sheetId);
    }

    const existing = await getSheetMeta(sheetId);
    for (const tab of Object.keys(TABS)) {
      await ensureTab(sheetId, existing, tab);
      log.push(`✅ Onglet '${tab}' prêt`);
    }

    await Promise.all(Object.entries(TABS).map(([tab, h]) => sheetsPut(sheetId!, `${tab}!A1`, [h])));
    log.push("📋 Headers écrits (5 onglets)");

    const comps = await sheetsGet(sheetId, "COMPETITIONS!A2:A2");
    if (!comps.length) {
      await sheetsAppend(sheetId, "COMPETITIONS!A:H", DEFAULT_COMPETITIONS);
      log.push(`⚽ ${DEFAULT_COMPETITIONS.length} compétitions insérées`);
    } else log.push("⚽ COMPETITIONS déjà rempli");

    const tpls = await sheetsGet(sheetId, "TEMPLATES!A2:A2");
    if (!tpls.length) {
      await sheetsAppend(sheetId, "TEMPLATES!A:F", DEFAULT_TEMPLATES);
      log.push(`💬 ${DEFAULT_TEMPLATES.length} templates insérés`);
    } else log.push("💬 TEMPLATES déjà rempli");

    return new Response(JSON.stringify({ ok: true, sheet_id: sheetId, sheet_name: SHEET_NAME, log }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), log }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});