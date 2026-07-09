/**
    * API-Football (live) — Source : free-api-live-football-data (RapidAPI)
    *
    * Remplace l'ancien wrapper api-football.com (déprécié, voir historique git).
    * Host : free-api-live-football-data.p.rapidapi.com
    * Clé env : RAPIDAPI_KEY (partagée avec sofascore.ts)
    *
    * Endpoints utilisés :
    *   /football-players-search?search={q}  → recherche de joueurs par nom
    *
    * Testé le 09/07/2026 : réponse réelle de la forme
    *   { status: "success", response: { suggestions: [{ type: "player", id, name, teamId, teamName, isCoach }, ...] } }
    * Les suggestions mélangent joueurs, équipes et coachs (champ "type").
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

    export interface AfPlayerSuggestion {
    type:      'player' | 'team' | string;
    id:        string | number;
    score?:    number;
    name:      string;
    isCoach?:  boolean;
    teamId?:   number | string;
    teamName?: string;
    }

    // ─── Recherche de joueurs par nom ─────────────────────────────────────────────
    // GET /football-players-search?search={q}
    // Ne retourne que les suggestions de type "player" (filtre les équipes/coachs).

    export async function searchPlayers(query: string): Promise<AfPlayerSuggestion[]> {
    if (!query || !query.trim()) return [];
    const data = await afGet(`/football-players-search?search=${encodeURIComponent(query.trim())}`);
    const suggestions: AfPlayerSuggestion[] = data?.response?.suggestions ?? [];
    return suggestions.filter((s) => s.type === 'player' && !s.isCoach);
    }
    