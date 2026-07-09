/**
 * fetch-matches — Ingestion dynamique
 *
 * Workflow:
 * 1. Récupère les matchs à venir/récents via teams/get-near-events pour
 *    chaque équipe extraite du classement de tournoi (découverte dynamique).
 * 2. Pour chaque match trouvé, appelle EN PARALLÈLE tous les endpoints
 *    de marché disponibles (statistiques, lineups, incidents, h2h, odds…).
 * 3. Stocke chaque type de données dans marches_bruts (JSONB) sans schéma fixe.
 * 4. Anti-doublon : ne refetch pas un marché déjà présent (< REFRESH_HOURS).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  getTeamNearEvents,
  getTournamentStandings,
  fetchAllMarkets,
  buildCustomId,
} from '../_shared/sofascore.ts';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

// IDs de compétitions à surveiller (seed minimal — uniquement les tournois, pas les marchés)
const TOURNAMENT_SEEDS: Array<{ id: string; name: string; seasonId: string }> = [
  { id: '17',    name: 'Ligue 1',          seasonId: '61737' },
  { id: '8',     name: 'Premier League',   seasonId: '61627' },
  { id: '23',    name: 'La Liga',          seasonId: '61643' },
  { id: '35',    name: 'Bundesliga',       seasonId: '61738' },
  { id: '23160', name: 'Serie A',          seasonId: '61664' },
  { id: '7',     name: 'Champions League', seasonId: '61644' },
];

const REFRESH_HOURS = 3;  // Ne re-fetche pas un marché de moins de 3h

// ─── Indexer un match dans matchs_index ────────────────────────────────────
async function indexMatch(event: any, competition: string, tournamentId: string, seasonId: string) {
  const matchId   = String(event.id);
  const homeTeam  = event.homeTeam?.name ?? '';
  const awayTeam  = event.awayTeam?.name ?? '';
  const homeSlug  = event.homeTeam?.slug ?? '';
  const awaySlug  = event.awayTeam?.slug ?? '';
  const matchDate = new Date((event.startTimestamp ?? 0) * 1000).toISOString();
  const status    = event.status?.type === 'finished' ? 'finished'
                  : event.status?.type === 'inprogress' ? 'inprogress'
                  : 'scheduled';
  const homeScore = event.homeScore?.current ?? null;
  const awayScore = event.awayScore?.current ?? null;

  await supabase.from('matchs_index').upsert({
    match_id:      matchId,
    home_team:     homeTeam,
    away_team:     awayTeam,
    home_team_id:  String(event.homeTeam?.id ?? ''),
    away_team_id:  String(event.awayTeam?.id ?? ''),
    home_slug:     homeSlug,
    away_slug:     awaySlug,
    competition,
    tournament_id: tournamentId,
    season_id:     seasonId,
    match_date:    matchDate,
    status,
    home_score:    homeScore,
    away_score:    awayScore,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'match_id' });

  return { matchId, homeTeam, awayTeam, matchDate, status,
           homeTeamId: String(event.homeTeam?.id ?? ''),
           awayTeamId: String(event.awayTeam?.id ?? ''),
           customId: buildCustomId(homeSlug, awaySlug) };
}

// ─── Vérifier quels marchés sont déjà frais pour un match ──────────────────
async function getMarchesFrais(matchId: string): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - REFRESH_HOURS * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('marches_bruts')
    .select('marche_slug')
    .eq('match_id', matchId)
    .gte('fetched_at', cutoff);
  return new Set((data ?? []).map((r: any) => r.marche_slug));
}

// ─── Stocker les marchés bruts ──────────────────────────────────────────────
async function stockerMarches(matchId: string, marches: Array<{ slug: string; donnees: any }>) {
  let stored = 0;
  for (const { slug, donnees } of marches) {
    const { error } = await supabase.from('marches_bruts').upsert({
      match_id:    matchId,
      marche_slug: slug,
      donnees,
      source:      'sofascore',
      fetched_at:  new Date().toISOString(),
    }, { onConflict: 'match_id,marche_slug' });
    if (!error) stored++;
  }
  return stored;
}

// ─── Ingestion complète pour une équipe ────────────────────────────────────
async function ingererEquipe(
  teamId: string,
  competition: string,
  tournamentId: string,
  seasonId: string,
  stats: { matchs: number; marches: number; erreurs: number }
) {
  const data = await getTeamNearEvents(teamId);
  const events: any[] = data?.events ?? [];
  if (!events.length) return;

  for (const event of events) {
    try {
      const { matchId, homeTeamId, awayTeamId, customId } =
        await indexMatch(event, competition, tournamentId, seasonId);

      // Vérifier AVANT tout appel API quels marchés sont déjà frais
      const marchesFrais = await getMarchesFrais(matchId);
      const slugsAFetcher = [...MARKET_ENDPOINTS.map(m => m.slug), 'h2h', 'stats_domicile', 'stats_exterieur']
        .filter(s => !marchesFrais.has(s));

      if (!slugsAFetcher.length) continue; // Tout est frais → zéro appel API

      // Fetch dynamique uniquement des marchés manquants/expirés
      const marches = await fetchAllMarkets(
        matchId, customId, homeTeamId, awayTeamId, tournamentId, seasonId
      );
      const marchesNouveaux = marches.filter(m => !marchesFrais.has(m.slug));

      const nb = await stockerMarches(matchId, marchesNouveaux);
      stats.matchs++;
      stats.marches += nb;
    } catch (e) {
      stats.erreurs++;
      console.error('Erreur match', event.id, e);
    }
  }
}

// ─── Handler principal ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Sécurité: vérifier CRON_SECRET pour bloquer les appels non autorisés
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const stats = { matchs: 0, marches: 0, erreurs: 0, equipes: 0 };

  for (const tournament of TOURNAMENT_SEEDS) {
    try {
      // Récupérer les équipes du classement pour ce tournoi (découverte dynamique)
      const standings = await getTournamentStandings(tournament.id, tournament.seasonId);
      const rows: any[] = standings?.standings?.[0]?.rows ?? [];

      if (!rows.length) continue;

      // Ingérer les matchs de chaque équipe classée EN PARALLÈLE (par lots de 5)
      for (let i = 0; i < rows.length; i += 5) {
        const batch = rows.slice(i, i + 5);
        await Promise.allSettled(batch.map(row => {
          const teamId = String(row.team?.id ?? '');
          if (!teamId) return Promise.resolve();
          stats.equipes++;
          return ingererEquipe(teamId, tournament.name, tournament.id, tournament.seasonId, stats);
        }));
      }
    } catch (e) {
      console.error('Erreur tournoi', tournament.name, e);
    }
  }

  return new Response(JSON.stringify({
    success:       true,
    equipes:       stats.equipes,
    matchs_index:  stats.matchs,
    marches_bruts: stats.marches,
    erreurs:       stats.erreurs,
    timestamp:     new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
