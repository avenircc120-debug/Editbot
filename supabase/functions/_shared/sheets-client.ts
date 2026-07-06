// _shared/sheets-client.ts — Wrapper Sheets + Drive API (SA OAuth2)
import { getAccessToken } from "./sa-auth.ts";

const DRIVE_BASE  = "https://www.googleapis.com/drive/v3";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_SCOPE  = "https://www.googleapis.com/auth/drive";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export async function findSheetByName(name: string): Promise<string | null> {
  const token = await getAccessToken([DRIVE_SCOPE]);
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  const r = await fetch(`${DRIVE_BASE}/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  return j.files?.[0]?.id ?? null;
}

export async function createSheet(title: string): Promise<string> {
  const token = await getAccessToken([DRIVE_SCOPE, SHEETS_SCOPE]);
  const r = await fetch(SHEETS_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title } }),
  });
  const j = await r.json();
  if (!j.spreadsheetId) throw new Error(`Création Sheet échouée : ${JSON.stringify(j)}`);
  return j.spreadsheetId;
}

async function sheetsAuth(): Promise<string> {
  return getAccessToken([SHEETS_SCOPE]);
}

export async function sheetsGet(sheetId: string, range: string): Promise<string[][]> {
  const token = await sheetsAuth();
  const r = await fetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const j = await r.json();
  return j.values ?? [];
}

export async function sheetsPut(sheetId: string, range: string, values: unknown[][]): Promise<void> {
  const token = await sheetsAuth();
  await fetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
}

export async function sheetsAppend(sheetId: string, range: string, values: unknown[][]): Promise<void> {
  const token = await sheetsAuth();
  await fetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
}

export async function sheetsUpdateCell(sheetId: string, range: string, value: string): Promise<void> {
  const token = await sheetsAuth();
  await fetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
}

export async function getSheetMeta(sheetId: string): Promise<{ title: string; id: number }[]> {
  const token = await sheetsAuth();
  const r = await fetch(`${SHEETS_BASE}/${sheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  return (j.sheets ?? []).map((s: any) => ({ title: s.properties.title, id: s.properties.sheetId }));
}

export async function ensureTab(sheetId: string, existing: { title: string }[], title: string): Promise<void> {
  if (existing.find((s) => s.title === title)) return;
  const token = await sheetsAuth();
  await fetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
}