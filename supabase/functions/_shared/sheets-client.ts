// _shared/sheets-client.ts — Google Sheets via WIF (écriture) + API key (lecture rapide)
// Lecture  → GOOGLE_SHEETS_KEY (API key, pas d'auth overhead)
// Écriture → WIF token (getWIFToken) via Workload Identity Federation

import { getWIFToken } from "./wif-auth.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_KEY  = Deno.env.get("GOOGLE_SHEETS_KEY") ?? "";
const SHEETS_ID   = Deno.env.get("GOOGLE_SHEETS_ID")  ?? "";

// ── LECTURE (API key) ─────────────────────────────────────────────────────────

/** Lit une plage A1. Ex: "COMPETITIONS!A2:F100"
 *  Nécessite que le sheet soit partagé en lecture publique. */
export async function sheetsGet(
  range: string,
  sheetId = SHEETS_ID,
): Promise<string[][]> {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?key=${SHEETS_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`Sheets GET ${range} → ${r.status}: ${await r.text()}`);
  const j = await r.json() as { values?: string[][] };
  return j.values ?? [];
}

/** Lit les métadonnées du sheet (liste des onglets) */
export async function getSheetMeta(sheetId = SHEETS_ID) {
  const url = `${SHEETS_BASE}/${sheetId}?key=${SHEETS_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`Sheets meta → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── ÉCRITURE (WIF token) ──────────────────────────────────────────────────────

/** Ajoute des lignes à la fin d'un onglet (append). */
export async function sheetsAppend(
  range: string,
  values: string[][],
  sheetId = SHEETS_ID,
): Promise<void> {
  const token = await getWIFToken();
  const url   = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append`
    + "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  if (!r.ok) throw new Error(`Sheets APPEND ${range} → ${r.status}: ${await r.text()}`);
}

/** Met à jour une plage précise (batchUpdate values). */
export async function sheetsPut(
  range: string,
  values: string[][],
  sheetId = SHEETS_ID,
): Promise<void> {
  const token = await getWIFToken();
  const url   = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`
    + "?valueInputOption=USER_ENTERED";
  const r = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  if (!r.ok) throw new Error(`Sheets PUT ${range} → ${r.status}: ${await r.text()}`);
}

/** Met à jour une seule cellule. Ex: updateCell("ANALYSE_IA_GROQ!I5", "true") */
export async function sheetsUpdateCell(
  cell: string,
  value: string,
  sheetId = SHEETS_ID,
): Promise<void> {
  await sheetsPut(cell, [[value]], sheetId);
}

/** Batch update multiple plages en un seul appel API. */
export async function sheetsBatchUpdate(
  data: { range: string; values: string[][] }[],
  sheetId = SHEETS_ID,
): Promise<void> {
  const token = await getWIFToken();
  const url   = `${SHEETS_BASE}/${sheetId}/values:batchUpdate`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!r.ok) throw new Error(`Sheets BATCH ${r.status}: ${await r.text()}`);
}
