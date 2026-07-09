/**
 * fetch-matches — Ingestion dynamique avec protection de quota
 *
 * Workflow:
 * 1. Lit l'état du quota RapidAPI avant de commencer.
 * 2. Pour chaque tournoi, récupère le classement (1 appel RapidAPI).
 * 3. Pour chaque équipe, récupère ses matchs proches (1 appel RapidAPI).
 * 4. Pour chaque match, fetche EN PARALLÈLE tous les marchés disponibles
 *    (1 appel par endpoint) — uniquement si le marché n'est pas déjà frais.
 * 5. Chaque appel RapidAPI est protégé par quota_consommer().
 * 6. Stoppe dès que le quota journalier est atteint.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  getTeamNearEvents,
  getTournamentStandings,
  fetchAllMarketsAvecQuota,
  buildCustomId,
  MARKET_ENDPOINTS,
} from '../_shared/sofascore.ts';
import { lireQuotas } from '../_shared/quota.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

// Compétitions à surveiller — réduites au minimum pour économiser les appels
// Priorité aux compétitions les plus demandées par les utilisateurs
const TOURNAMENT_SEEDS: Array<{ id: string; name: string; seasonId: string }> = [
  { id: '17', name: 'Ligue 1',          seasonId: '61737' },
  { id: '7',  name: 'Champions League', seasonId: '61644' },
  { id: '8',  name: 'Premier League',   seasonId: '61627' },
];

// Paramètres d'économie de quota
const REFRESH_HOURS   = 12;  // Données fraîches pendant 12h (au lieu de 3h)
const MAX_EQUIPES     = 5;   // Max 5 équipes par tournoi (pas les 20)
const MAX_MATCHS      = 2;   // Max 2 matchs par équipe (prochain + dernier)

// ─── Indexer un match dans matchs_index ────────────────────────────────────
async function indexMatch(event: any, competition: string, tournamentId: string, seasonId: string) {
  const matchId   = String(event.id);
  const homeSlug  = event.homeTeam?.slug ?? '';
  const awaySlug  = event.awayTeam?.slug ?? '';
  const matchDate = new Date((event.startTimestamp ?? 0) * 1000).toISOString();
  const status    = event.status?.type === 'finished'    ? 'finished'
                  : event.status?.type === 'inprogress'  ? 'inprogress'
                  : 'scheduled';

  await supabase.from('matchs_index').upsert({
    match_id:      matchId,
    home_team:     event.homeTeam?.name ?? '',
    away_team:     event.awayTeam?.name ?? '',
    home_team_id:  String(event.homeTeam?.id ?? ''),
    away_team_id:  String(event.awayTeam?.id ?? ''),
    home_slug:     homeSlug,
    away_slug:     awaySlug,
    competition,
    tournament_id: tournamentId,
    season_id:     seasonId,
    match_date:    matchDate,
    status,
    home_score:    event.homeScore?.current ?? null,
    away_score:    event.awayScore?.current ?? null,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'match_id' });

  return {
    matchId,
    homeTeamId: String(event.homeTeam?.id ?? ''),
    awayTeamId: String(event.awayTeam?.id ?? ''),
    customId:   buildCustomId(homeSlug, awaySlug),
    status,
  };
}

// ─── Quels marchés sont encore frais ? (évite les appels API inutiles) ─────
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

// ─── Ingestion d'une équipe ─────────────────────────────────────────────────
async function ingererEquipe(
  teamId: string,
  competition: string,
  tournamentId: string,
  seasonId: string,
  stats: { matchs: number; marches: number; skips: number },
): Promise<boolean> {
  // 1 appel RapidAPI — vérification du quota dans fetchAllMarketsAvecQuota
  const data = await getTeamNearEvents(teamId, supabase);
  if (!data) return false; // Quota épuisé signalé par retour null

  const events: any[] = (data?.events ?? []).slice(0, MAX_MATCHS);
  if (!events.length) return true;

  for (const event of events) {
    const { matchId, homeTeamId, awayTeamId, customId } =
      await indexMatch(event, competition, tournamentId, seasonId);

    // Vérifier quels marchés sont déjà frais → zéro appel API si tout est frais
    const marchesFrais = await getMarchesFrais(matchId);
    const tousLesSlugs = [...MARKET_ENDPOINTS.map(m => m.slug), 'h2h', 'stats_domicile', 'stats_exterieur'];
    const aFetcher     = tousLesSlugs.filter(s => !marchesFrais.has(s));

    if (!aFetcher.length) {
      stats.skips++;
      continue; // Tout est frais → on ne consomme pas de quota
    }

    // Fetch dynamique avec vérification de quota pour chaque appel
    const marches = await fetchAllMarketsAvecQuota(
      supabase, matchId, customId, homeTeamId, awayTeamId, tournamentId, seasonId,
    );

    if (marches === null) return false; // Quota global épuisé → arrêter

    const nouveaux = marches.filter(m => !marchesFrais.has(m.slug));
    const nb = await stockerMarches(matchId, nouveaux);
    stats.matchs++;
    stats.marches += nb;
  }

  return true; // Continue
}

// ─── Handler principal ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stats = { matchs: 0, marches: 0, skips: 0 };
  let quotaEpuise = false;

  // Rapport initial de quota
  const quotaAvant = await lireQuotas(supabase);

  boucle:
  for (const tournament of TOURNAMENT_SEEDS) {
    // 1 appel RapidAPI pour le classement
    const standings = await getTournamentStandings(tournament.id, tournament.seasonId, supabase);
    if (!standings) { quotaEpuise = true; break; }

    const rows: any[] = (standings?.standings?.[0]?.rows ?? []).slice(0, MAX_EQUIPES);
    if (!rows.length) continue;

    for (const row of rows) {
      const teamId = String(row.team?.id ?? '');
      if (!teamId) continue;

      const continuer = await ingererEquipe(
        teamId, tournament.name, tournament.id, tournament.seasonId, stats,
      );
      if (!continuer) { quotaEpuise = true; break boucle; }
    }
  }

  const quotaApres = await lireQuotas(supabase);

  return new Response(JSON.stringify({
    success:        true,
    matchs_indexes: stats.matchs,
    marches_stockes: stats.marches,
    matchs_en_cache: stats.skips,
    quota_epuise:   quotaEpuise,
    quota_rapidapi: quotaApres.rapidapi ?? null,
    quota_groq:     quotaApres.groq ?? null,
    quota_consomme: {
      rapidapi: (quotaApres.rapidapi?.compteur ?? 0) - (quotaAvant.rapidapi?.compteur ?? 0),
    },
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
