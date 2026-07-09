/**
    * API-Football (live) — Source : free-api-live-football-data (RapidAPI)
    *
    * Remplace l'ancien wrapper api-football.com (déprécié, voir historique git).
    * Host : free-api-live-football-data.p.rapidapi.com
    * Clé env : RAPIDAPI_KEY (partagée avec sofascore.ts)
    *
    * Endpoints utilisés :
    *   /football-players-search?search={q}  → recherche de joueurs par nom
    */

    const APIFOOTBALL_HOST = 'free-api-live-football-data.p.rapidapi.com';
    const APIFOOTBALL_BASE = `https://${APIFOOTBALL_HOST}`;
    const RAPIDAPI_KEY      = Deno.env.get('RAPIDAPI_KEY') ?? '';

    function afHeaders(): HeadersInit {
    return {
      'Content-Type':    'application/json',
      'x-rapidapi-host': APIFOOTBALL_HOST,
      'x-rapidapi-key':  RAPIDAPI_KEY,
    };
    }

    async function afGet(path: string): Promise<any | null> {
    const url = `${APIFOOTBALL_BASE}${path}`;
    try {
      const res = await fetch(url, { headers: afHeaders() });
      if (res.status === 204 || res.status === 404) return null;
      if (!res.ok) {
        console.warn(`[apifootball] HTTP ${res.status} — ${path}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn(`[apifootball] Erreur réseau — ${path}:`, e);
      return null;
    }
    }

    // ─── Types ────────────────────────────────────────────────────────────────────

    export interface AfPlayer {
    id?:        number | string;
    name?:      string;
    position?:  string;
    team?:      string;
    country?:   string;
    [key: string]: unknown;
    }

    // ─── Recherche de joueurs par nom ─────────────────────────────────────────────
    // GET /football-players-search?search={q}

    export async function searchPlayers(query: string): Promise<AfPlayer[]> {
    if (!query || !query.trim()) return [];
    const data = await afGet(`/football-players-search?search=${encodeURIComponent(query.trim())}`);
    if (!data) return [];
    // La forme exacte de la réponse dépend du plan RapidAPI ; on gère les
    // variantes courantes (response.players / data.response / tableau direct).
    const list =
      data?.response?.players ??
      data?.response ??
      data?.data ??
      data;
    return Array.isArray(list) ? (list as AfPlayer[]) : [];
    }
    