/**
    * live-cron — Cron intelligent pour les scores en direct
    *
    * Logique :
    *  1. Interroge Supabase pour identifier les matchs actuellement en direct
    *     (status = 'inprogress') OU imminents (match_date dans les 15 prochaines min).
    *  2. Si aucun match en direct → sortie immédiate, AUCUN appel API externe.
    *  3. Clé premium (v2) → 1 seul appel livescores/soccer pour tout récupérer.
    *  4. Clé gratuite (v1) → appels lookupevent.php individuels.
    *     Cron à 90s = max 40 runs/heure, largement sous le plafond de 30 req/min.
    *  5. Upsert DB + déclenche facebook-post si score/statut changé.
    *  6. Stoppe automatiquement les requêtes quand un match passe à 'finished'.
    *
    * Fréquence cron recommandée : toutes les 90 secondes
    * Sécurité : header Authorization: Bearer {CRON_SECRET}
    */

    import { createClient } from 'npm:@supabase/supabase-js@2';
    import {
    getEvenementDetails,
    getLivescoresSoccer,
    tsdbTimestampToDate,
    estTermine,
    type TsdbMatch,
    } from '../_shared/thesportsdb.ts';
    import {
    getLiveEventsSofascore,
    trouverEvenementSofascore,
    statutSofaVersInterne,
    } from '../_shared/sofascore.ts';

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const CRON_SECRET  = Deno.env.get('CRON_SECRET')               ?? '';
    const TSDB_KEY     = Deno.env.get('THESPORTSDB_KEY')            ?? '123';
    const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Clé premium = toute clé différente de la clé gratuite publique
    const isPremium = TSDB_KEY !== '123' && TSDB_KEY !== '3' && TSDB_KEY.length > 5;

    // ─── Normalisation status ─────────────────────────────────────────────────────

    function normaliserStatus(s: string | undefined): string {
    switch ((s ?? '').toUpperCase()) {
      case 'FT': case 'AET': case 'PEN': return 'finished';
      case 'HT': case '1H': case '2H': case 'ET': return 'inprogress';
      case 'PST': case 'CANC': case 'ABD': return 'postponed';
      default: return 'scheduled';
    }
    }

    // ─── Mise à jour d'un match et détection de changement ───────────────────────

    interface MatchChange {
    matchId: string; competition: string;
    homeTeam: string; awayTeam: string;
    homeScore: number; awayScore: number;
    status: string; rawStatus: string; minute: number | null;
    }

    async function mettreAJourMatch(ev: TsdbMatch): Promise<MatchChange | null> {
    if (!ev.strHomeTeam || !ev.strAwayTeam) return null;

    const status    = normaliserStatus(ev.strStatus);
    const rawStatus = (ev.strStatus ?? 'NS').toUpperCase();
    const homeScore = ev.intHomeScore != null ? Number(ev.intHomeScore) : 0;
    const awayScore = ev.intAwayScore != null ? Number(ev.intAwayScore) : 0;
    const minute    = ev.strProgress ? parseInt(ev.strProgress, 10) : null;
    const matchDate = tsdbTimestampToDate(ev.strTimestamp, ev.strTime).toISOString();

    const { data: avant } = await supabase
      .from('matchs_index')
      .select('status, home_score, away_score, competition')
      .eq('match_id', ev.idEvent)
      .maybeSingle();

    if (!avant) return null; // Inconnu → fetch-matches gère l'insertion

    const { error } = await supabase.from('matchs_index').upsert({
      match_id:        ev.idEvent,
      home_team:       ev.strHomeTeam,
      away_team:       ev.strAwayTeam,
      home_team_id:    ev.idHomeTeam ?? null,
      away_team_id:    ev.idAwayTeam ?? null,
      competition:     avant.competition ?? ev.strLeague ?? '',
      tournament_id:   ev.idLeague ?? null,
      match_date:      matchDate,
      status,
      raw_status:      rawStatus,
      home_score:      homeScore,
      away_score:      awayScore,
      id_thesportsdb:  ev.idEvent,
      home_team_badge: ev.strHomeTeamBadge ?? null,
      away_team_badge: ev.strAwayTeamBadge ?? null,
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'match_id' });

    if (error) { console.warn('[live-cron] upsert', ev.idEvent, error.message); return null; }

    const changed = avant.home_score !== homeScore
      || avant.away_score !== awayScore
      || avant.status !== status;

    if (!changed) return null;

    return {
      matchId: ev.idEvent,
      competition: avant.competition ?? ev.strLeague ?? '',
      homeTeam: ev.strHomeTeam, awayTeam: ev.strAwayTeam,
      homeScore, awayScore, status, rawStatus, minute,
    };
    }

    // ─── Déclenchement facebook-post ─────────────────────────────────────────────

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

    // ─── Handler principal ────────────────────────────────────────────────────────

    Deno.serve(async (req: Request) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const now   = new Date();
    const stats = { matchsLive: 0, matchsMisAJour: 0, apiCalls: 0, source: '', skipped: false };

    // ── Étape 1 : Identifier les matchs en direct ou imminents (DB only) ─────────
    // Fenêtre : -180 min (matchs qui auraient dû commencer — large pour rattraper
    // un match resté bloqué sur "scheduled" après une panne du cron) à +3h (FT tardifs)
    const debutFenetre = new Date(now.getTime() - 180 * 60 * 1000).toISOString();
    const finFenetre   = new Date(now.getTime() + 180 * 60 * 1000).toISOString();

    const { data: matchsAttendus } = await supabase
      .from('matchs_index')
      .select('match_id, status, id_thesportsdb, competition, home_team, away_team, home_score, away_score')
      .neq('status', 'postponed')
      .neq('status', 'finished')
      .or(
        'status.eq.inprogress,' +
        `and(status.eq.scheduled,match_date.gte.${debutFenetre},match_date.lte.${finFenetre})`
      );

    if (!matchsAttendus?.length) {
      stats.skipped = true;
      return new Response(
        JSON.stringify({ success: true, message: 'Aucun match en direct — aucun appel API.', ...stats }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    stats.matchsLive = matchsAttendus.length;
    const matchsModifies: MatchChange[] = [];

    // ── Étape 2 : Récupérer les scores ────────────────────────────────────────────

    if (isPremium) {
      // V2 premium : 1 seul appel couvre TOUS les matchs soccer en direct
      stats.source   = 'v2-livescores';
      stats.apiCalls = 1;
      const livescores = await getLivescoresSoccer();

      if (livescores.length > 0) {
        const liveMap = new Map(livescores.map(ev => [ev.idEvent, ev]));
        for (const match of matchsAttendus) {
          const idEvent = match.id_thesportsdb ?? match.match_id;
          const ev      = liveMap.get(idEvent);
          if (!ev) continue;
          const changed = await mettreAJourMatch(ev);
          if (changed) matchsModifies.push(changed);
        }
      }
    } else {
      // V1 gratuit : lookupevent.php par match
      // 90 secondes entre chaque run cron = max 40 runs/h
      // Avec 20 matchs simultanés max : 20 req × 40 runs/h = 800 req/h << 30 req/min = 1800/h
      stats.source = 'v1-lookupevent';

      for (const match of matchsAttendus) {
        const idEvent = match.id_thesportsdb ?? match.match_id;
        if (!idEvent || idEvent.startsWith('odds_')) continue;

        stats.apiCalls++;
        const ev = await getEvenementDetails(idEvent);
        if (!ev) continue;

        const changed = await mettreAJourMatch(ev);
        if (changed) matchsModifies.push(changed);

        if (estTermine(ev.strStatus ?? '')) {
          console.log(`[live-cron] ${idEvent} terminé (FT)`);
        }
      }
    }

    // ── Étape 2.5 : SofaScore (secours universel, sans clé ni quota) ───────────
    // Comble les trous laissés par TheSportsDB (quota épuisé) et les matchs sans
    // id_thesportsdb (ex : importés via Odds API, qui ne donne pas de détails
    // live) — 1 seul appel couvre tout le football mondial en direct, donc
    // aucun souci de quota à surveiller ici.
    try {
      const dejaTraites = new Set(matchsModifies.map(m => m.matchId));
      const restants = matchsAttendus.filter(m => !dejaTraites.has(m.match_id));

      if (restants.length > 0) {
        const sofaEvents = await getLiveEventsSofascore();
        for (const match of restants) {
          const found = trouverEvenementSofascore(sofaEvents, match.home_team, match.away_team);
          if (!found) continue;

          const status     = statutSofaVersInterne(found.status?.type ?? '');
          const homeScore  = found.homeScore?.current ?? 0;
          const awayScore  = found.awayScore?.current ?? 0;
          const changed    = match.status !== status
            || match.home_score !== homeScore
            || match.away_score !== awayScore;

          if (!changed) continue;

          const { error } = await supabase.from('matchs_index').update({
            status,
            raw_status: found.status?.description ?? null,
            home_score: homeScore,
            away_score: awayScore,
            updated_at: new Date().toISOString(),
          }).eq('match_id', match.match_id);

          if (error) { console.warn('[live-cron][sofascore] update', match.match_id, error.message); continue; }

          matchsModifies.push({
            matchId: match.match_id,
            competition: match.competition,
            homeTeam: match.home_team, awayTeam: match.away_team,
            homeScore, awayScore, status,
            rawStatus: found.status?.description ?? '',
            minute: null,
          });
        }
      }
    } catch (e) {
      console.warn('[live-cron] Erreur SofaScore:', e);
    }

    stats.matchsMisAJour = matchsModifies.length;

    // ── Étape 3 : Diffuser sur Facebook si changement ────────────────────────────
    await diffuserSurFacebook(matchsModifies);

    return new Response(
      JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    });
    