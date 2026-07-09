import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getTeamNearEvents, extractForm } from '../_shared/sofascore.ts';
import { COMPETITIONS } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Équipes à surveiller par compétition (ID SofaScore)
const TEAMS_TO_WATCH: Record<string, Array<{ id: string; name: string }>> = {
  '17': [ // Ligue 1
    { id: '1664', name: 'Paris Saint-Germain' },
    { id: '2953', name: 'Olympique de Marseille' },
    { id: '4481', name: 'Olympique Lyonnais' },
    { id: '2953', name: 'Monaco' },
    { id: '4489', name: 'Lille' },
  ],
  '8': [ // Premier League
    { id: '17', name: 'Manchester City' },
    { id: '32', name: 'Arsenal' },
    { id: '31', name: 'Liverpool' },
    { id: '35', name: 'Chelsea' },
    { id: '29', name: 'Manchester United' },
  ],
  '23': [ // La Liga
    { id: '2817', name: 'Real Madrid' },
    { id: '2818', name: 'FC Barcelona' },
    { id: '2836', name: 'Atletico Madrid' },
  ],
};

async function fetchAndStoreTeamMatches(
  team: { id: string; name: string },
  competitionId: string
) {
  const competition = COMPETITIONS[competitionId] ?? 'Inconnu';

  try {
    const data = await getTeamNearEvents(team.id);
    if (!data?.events) return 0;

    let stored = 0;
    for (const event of data.events) {
      const matchId = event.id?.toString();
      if (!matchId) continue;

      // Vérifier si le match existe déjà (anti-doublon)
      const { data: existing } = await supabase
        .from('matchs_historique')
        .select('match_id')
        .eq('match_id', matchId)
        .single();

      if (existing) continue; // Déjà en base → on skip

      const homeTeam = event.homeTeam?.name ?? '';
      const awayTeam = event.awayTeam?.name ?? '';
      const matchDate = new Date(event.startTimestamp * 1000).toISOString();
      const status = event.status?.type === 'finished' ? 'finished' : 'scheduled';
      const homeScore = event.homeScore?.current ?? null;
      const awayScore = event.awayScore?.current ?? null;

      // Extraire la forme récente
      const homeForm = extractForm(data.events, event.homeTeam?.id?.toString() ?? '');
      const awayForm = extractForm(data.events, event.awayTeam?.id?.toString() ?? '');

      const { error } = await supabase.from('matchs_historique').insert({
        match_id: matchId,
        competition,
        competition_id: competitionId,
        home_team: homeTeam,
        away_team: awayTeam,
        home_team_id: event.homeTeam?.id?.toString(),
        away_team_id: event.awayTeam?.id?.toString(),
        match_date: matchDate,
        status,
        home_score: homeScore,
        away_score: awayScore,
        home_form: homeForm,
        away_form: awayForm,
      });

      if (!error) stored++;
    }
    return stored;
  } catch (e) {
    console.error(`Erreur équipe ${team.name}:`, e);
    return 0;
  }
}

Deno.serve(async (req) => {
  // Sécurité: vérifier header si appelé depuis CRON
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  let totalStored = 0;
  const results: string[] = [];

  for (const [competitionId, teams] of Object.entries(TEAMS_TO_WATCH)) {
    for (const team of teams) {
      const count = await fetchAndStoreTeamMatches(team, competitionId);
      totalStored += count;
      if (count > 0) results.push(`${team.name}: +${count} matchs`);
    }
  }

  return new Response(JSON.stringify({
    success: true,
    total_stored: totalStored,
    details: results,
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
