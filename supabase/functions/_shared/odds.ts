/**
 * odds.ts — Client The Odds API (fallback scores/calendrier)
 *
 * Utilisé en secours quand le quota TheSportsDB est épuisé.
 * Endpoint utilisé : /v4/sports/{sport}/scores?daysFrom=3
 *   → retourne en UN SEUL appel : matchs en direct + résultats récents
 *     + matchs à venir (scores null) pour une ligue donnée.
 *
 * Quota : 55 appels/jour. Ce module est appelé au maximum 2×/heure
 * (fenêtres :00 et :30) et seulement quand TheSportsDB est épuisé.
 */

const ODDS_API_KEY = Deno.env.get('ODDS_API_KEY') ?? '';
const BASE_URL     = 'https://api.the-odds-api.com/v4';

// ─── Mapping TSDB league ID → Odds API sport key ─────────────────────────────
export const TSDB_TO_ODDS: Record<string, { sportKey: string; competition: string }> = {
  '4328': { sportKey: 'soccer_epl',                        competition: 'Premier League'   },
  '4334': { sportKey: 'soccer_france_ligue_one',           competition: 'Ligue 1'          },
  '4335': { sportKey: 'soccer_spain_la_liga',              competition: 'La Liga'          },
  '4331': { sportKey: 'soccer_germany_bundesliga',         competition: 'Bundesliga'       },
  '4332': { sportKey: 'soccer_italy_serie_a',              competition: 'Serie A'          },
  '4480': { sportKey: 'soccer_uefa_champs_league',         competition: 'Champions League' },
  '4481': { sportKey: 'soccer_uefa_europa_league',         competition: 'Europa League'    },
  '4329': { sportKey: 'soccer_england_league1',            competition: 'Championship'     },
  '4337': { sportKey: 'soccer_netherlands_eredivisie',     competition: 'Eredivisie'       },
  '4344': { sportKey: 'soccer_portugal_primeira_liga',     competition: 'Primeira Liga'    },
  '4346': { sportKey: 'soccer_usa_mls',                    competition: 'MLS'              },
  '4351': { sportKey: 'soccer_brazil_campeonato',          competition: 'Brasileirao'      },
  '4350': { sportKey: 'soccer_mexico_ligamx',              competition: 'Liga MX'          },
  '4406': { sportKey: 'soccer_argentina_primera_division', competition: 'Liga Argentina'   },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OddsScore {
  name:  string;
  score: string | null;
}

export interface OddsEvent {
  id:            string;
  sport_key:     string;
  sport_title:   string;
  commence_time: string;
  completed:     boolean;
  home_team:     string;
  away_team:     string;
  scores:        OddsScore[] | null;
  last_update:   string | null;
}

export interface OddsMatchRow {
  match_id:      string;
  home_team:     string;
  away_team:     string;
  match_date:    string;
  status:        string;
  home_score:    number | null;
  away_score:    number | null;
  competition:   string;
  tournament_id: string;
}

// ─── Utilitaire HTTP ──────────────────────────────────────────────────────────

async function oddsGet(path: string): Promise<unknown | null> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE_URL}${path}${sep}apiKey=${ODDS_API_KEY}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 422) {
      console.warn(`[odds] 422 — sport key hors saison: ${path}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[odds] HTTP ${res.status} — ${path}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[odds] Erreur réseau:', e);
    return null;
  }
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normaliserStatut(ev: OddsEvent): string {
  if (ev.completed) return 'finished';
  if (ev.scores !== null) {
    // L'Odds API peut renvoyer completed=false même après la fin du match.
    // Si le coup d'envoi date de plus de 3h et qu'il y a des scores, c'est terminé.
    const elapsed = Date.now() - new Date(ev.commence_time).getTime();
    if (elapsed > 3 * 60 * 60 * 1000) return 'finished';
    return 'inprogress';
  }
  return 'scheduled';
}

function extraireScores(ev: OddsEvent): { home: number | null; away: number | null } {
  if (!ev.scores) return { home: null, away: null };
  const h = ev.scores.find(s => s.name === ev.home_team);
  const a = ev.scores.find(s => s.name === ev.away_team);
  return {
    home: h?.score != null ? Number(h.score) : null,
    away: a?.score != null ? Number(a.score) : null,
  };
}

async function getScoresSport(sportKey: string): Promise<OddsEvent[]> {
  const data = await oddsGet(`/sports/${sportKey}/scores?daysFrom=3&dateFormat=iso`);
  return Array.isArray(data) ? (data as OddsEvent[]) : [];
}

// ─── Entrée principale ────────────────────────────────────────────────────────

/**
 * Récupère tous les matchs des ligues configurées via Odds API.
 * Consomme 1 quota "odds" par ligue. S'arrête si quota épuisé.
 *
 * @param consommer  Fonction de consommation de quota passée par l'appelant.
 */
export async function getAllMatchsFallback(
  consommer: (api: string) => Promise<boolean>,
): Promise<OddsMatchRow[]> {
  const rows: OddsMatchRow[] = [];

  for (const [tsdbId, { sportKey, competition }] of Object.entries(TSDB_TO_ODDS)) {
    const ok = await consommer('odds');
    if (!ok) {
      console.warn('[odds] Quota épuisé — arrêt fallback');
      break;
    }

    const events = await getScoresSport(sportKey);

    for (const ev of events) {
      if (!ev.home_team || !ev.away_team) continue;
      const { home, away } = extraireScores(ev);
      rows.push({
        match_id:      `odds_${ev.id}`,
        home_team:     ev.home_team,
        away_team:     ev.away_team,
        match_date:    ev.commence_time,
        status:        normaliserStatut(ev),
        home_score:    home,
        away_score:    away,
        competition,
        tournament_id: tsdbId,
      });
    }
  }

  return rows;
}
