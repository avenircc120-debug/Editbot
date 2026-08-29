/**
    * live-cron — Cron intelligent pour les scores en direct
    */

    import { createClient } from 'npm:@supabase/supabase-js@2';
    import {
    getEspnEvents,
    trouverEvenementEspn,
    statutEspnVersInterne,
    scoreEspn,
    clockEspn,
    idEquipeEspn,
    buteursEquipe,
    ESPN_LEAGUE_SLUGS,
    lastFetchDiagnostics,
    } from '../_shared/espn.ts';

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const CRON_SECRET  = Deno.env.get('CRON_SECRET')               ?? '';
    const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

    interface MatchChange {
    matchId: string; competition: string;
    homeTeam: string; awayTeam: string;
    homeScore: number; awayScore: number;
    status: string; rawStatus: string; minute: number | null;
    eventType?: string | null;
    homeGoalDetails?: string | null;
    awayGoalDetails?: string | null;
    }

    async function diffuserSurFacebook(matchsModifies: MatchChange[]): Promise<void> {
    if (!matchsModifies.length) return;
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/facebook-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
        body: JSON.stringify({ matches: matchsModifies }),
      });
    } catch (e) { console.warn('[live-cron] facebook-post error:', e); }
    }

    Deno.serve(async (req: Request) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const now   = new Date();
    const stats = { matchsLive: 0, matchsMisAJour: 0, matchsClotures: 0, matchsPurges: 0, espnCount: -1, competitionsInterrogees: 0, source: 'espn', skipped: false };

    const seuilPurge = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const { data: purges } = await supabase
      .from('matchs_index')
      .update({ status: 'finished', raw_status: 'FT (auto)', updated_at: now.toISOString() })
      .in('status', ['inprogress', 'scheduled'])
      .lt('match_date', seuilPurge)
      .select('match_id');
    stats.matchsPurges = purges?.length ?? 0;

    const fenetreDebut = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const fenetreFin   = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    const { data: matchsAttendus } = await supabase
      .from('matchs_index')
      .select('match_id, status, tournament_id, competition, home_team, away_team, home_score, away_score, match_date, raw_status')
      .in('status', ['inprogress', 'scheduled'])
      .gte('match_date', fenetreDebut)
      .lte('match_date', fenetreFin);

    if (!matchsAttendus?.length) {
      stats.skipped = true;
      return new Response(
        JSON.stringify({ success: true, message: 'Aucun match en direct — aucun appel API.', ...stats }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    stats.matchsLive = matchsAttendus.length;
    const matchsModifies: MatchChange[] = [];

    const tournamentIds = [...new Set(matchsAttendus.map(m => m.tournament_id).filter(Boolean))] as string[];
    const { events: espnEvents, failedSlugs } = await getEspnEvents(tournamentIds);
    stats.espnCount = espnEvents.length;
    stats.competitionsInterrogees = tournamentIds.filter(id => ESPN_LEAGUE_SLUGS[id]).length;
    (stats as any).espnDiag = lastFetchDiagnostics;
    (stats as any).espnFailedSlugs = [...failedSlugs];

    for (const match of matchsAttendus) {
      const found = trouverEvenementEspn(espnEvents, match.home_team, match.away_team);

      if (found) {
        const status     = statutEspnVersInterne(found.status?.type?.state ?? '');
        const homeScore  = scoreEspn(found, 'home');
        const awayScore  = scoreEspn(found, 'away');
        const liveClock  = status === 'inprogress' ? clockEspn(found) : null;
        const changed    = match.status !== status
          || match.home_score !== homeScore
          || match.away_score !== awayScore
          || (status === 'inprogress' && match.raw_status !== liveClock);

        if (!changed) continue;

        // But marqué : ESPN fournit déjà le(s) buteur(s) dans
        // competitions[0].details (même réponse que le score/chrono, aucun
        // appel supplémentaire) — bien plus fiable que d'attendre TheSportsDB,
        // qui ne fournit d'ailleurs cette donnée sur aucun de ses endpoints
        // gratuits (vérifié : absente même de lookupevent.php).
        const butMarque = status === 'inprogress'
          && (homeScore > (match.home_score ?? 0) || awayScore > (match.away_score ?? 0));
        const homeGoalDetails = buteursEquipe(found, idEquipeEspn(found, 'home'));
        const awayGoalDetails = buteursEquipe(found, idEquipeEspn(found, 'away'));

        const { error } = await supabase.from('matchs_index').update({
          status,
          raw_status: liveClock ?? found.status?.type?.description ?? null,
          home_score: homeScore,
          away_score: awayScore,
          updated_at: new Date().toISOString(),
        }).eq('match_id', match.match_id);

        if (error) { console.warn('[live-cron][espn] update', match.match_id, error.message); continue; }

        matchsModifies.push({
          matchId: match.match_id,
          competition: match.competition,
          homeTeam: match.home_team, awayTeam: match.away_team,
          homeScore, awayScore, status,
          rawStatus: liveClock ?? found.status?.type?.description ?? '',
          minute: null,
          eventType: butMarque ? 'goal' : null,
          homeGoalDetails: homeGoalDetails || null,
          awayGoalDetails: awayGoalDetails || null,
        });
        continue;
      }

      const slug = match.tournament_id ? ESPN_LEAGUE_SLUGS[match.tournament_id] : undefined;
      const competitionInterrogee = Boolean(slug) && !failedSlugs.has(slug!);
      if (competitionInterrogee && match.status === 'inprogress') {
        const { error } = await supabase.from('matchs_index').update({
          status: 'finished',
          raw_status: 'FT (déduit)',
          updated_at: new Date().toISOString(),
        }).eq('match_id', match.match_id);

        if (error) { console.warn('[live-cron][cloture]', match.match_id, error.message); continue; }

        stats.matchsClotures++;
        matchsModifies.push({
          matchId: match.match_id,
          competition: match.competition,
          homeTeam: match.home_team, awayTeam: match.away_team,
          homeScore: match.home_score ?? 0, awayScore: match.away_score ?? 0,
          status: 'finished',
          rawStatus: 'FT (déduit)',
          minute: null,
        });
      }
    }

    stats.matchsMisAJour = matchsModifies.length;

    await diffuserSurFacebook(matchsModifies);

    return new Response(
      JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    });
