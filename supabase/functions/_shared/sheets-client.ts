// _shared/sheets-client.ts — Google Sheets READ-ONLY via API key
// Aucun Service Account requis. La feuille doit être partagée (lecture publique
// ou lien de partage "Toute personne avec le lien peut voir") pour que l'API key fonctionne.

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_KEY  = Deno.env.get("GOOGLE_SHEETS_KEY") ?? "";
const SHEETS_ID   = Deno.env.get("GOOGLE_SHEETS_ID")  ?? "";

/** Lit une plage A1. Ex: "COMPETITIONS!A2:F100" */
export async function sheetsGet(
  range: string,
  sheetId = SHEETS_ID,
): Promise<string[][]> {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?key=${SHEETS_KEY}`;
  const r = await fetch(url);
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Sheets GET ${range} → ${r.status}: ${err}`);
  }
  const j = await r.json();
  return (j.values as string[][]) ?? [];
}

/** Lit les métadonnées du sheet (liste des onglets) */
export async function getSheetMeta(sheetId = SHEETS_ID) {
  const url = `${SHEETS_BASE}/${sheetId}?key=${SHEETS_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheets meta → ${r.status}: ${await r.text()}`);
  return r.json();
}
