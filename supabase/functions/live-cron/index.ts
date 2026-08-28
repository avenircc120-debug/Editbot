/**
    * live-cron — Cron intelligent pour les scores en direct
    *
    * Logique :
    *  1. Interroge Supabase pour identifier les matchs actuellement en direct
    *     (status = 'inprogress') OU imminents (match_date dans les 15 prochaines min).
    *  2. Si aucun match en direct → sortie immédiate, AUCUN appel API externe.
    *  3. SofaScore (seule source, sans clé ni quota) → 1 seul appel couvre
    *     tout le football mondial en direct.
    *  4. Upsert DB + déclenche facebook-post si score/statut changé.
    *  5. Stoppe automatiquement les requêtes quand un match passe à 'finished'.
    *
    * Fréquence cron recommandée : toutes les 90 secondes
    * Sécurité : header Authorization: Bearer {CRON_SECRET}
    */

    import { createClient } from 'npm:@supabase/supabase-js@2';
    import {
    getLiveEventsSofascore,
    trouverEvenementSofascore,
    statutSofaVersInterne,
    } from '../_shared/sofascore.ts';

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const CRON_SECRET  = Deno.env.get('CRON_SECRET')               ?? '';
    const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ─── Mise à jour d'un match et détection de changement ───────────────────────

    interface MatchChange {
    matchId: string; competition: string;
    homeTeam: string; awayTeam: string;
    homeScore: number; awayScore: number;
    status: string; rawStatus: string; minute: number | null;
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

    // ── Étape 1 : Identifier les matchs réellement diffusés (broadcast actif) ────
    // On ne suit QUE les matchs qu'un utilisateur a sélectionnés pour diffusion
    // Facebook (broadcast_selections.is_active = true) — pas tous les matchs de
    // la planète dans une fenêtre horaire, ce qui faisait exploser le nombre
    // d'appels API (jusqu'à 280 par exécution) et vidait le quota TheSportsDB
    // en quelques minutes.
    const { data: selectionsActives } = await supabase
      .from('broadcast_selections')
      .select('match_id')
      .eq('is_active', true);

    const idsDiffuses = [...new Set((selectionsActives ?? []).map((s) => s.match_id))];

    if (!idsDiffuses.length) {
      stats.skipped = true;
      return new Response(
        JSON.stringify({ success: true, message: 'Aucune diffusion active — aucun appel API.', ...stats }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { data: matchsAttendus } = await supabase
      .from('matchs_index')
      .select('match_id, status, id_thesportsdb, competition, home_team, away_team, home_score, away_score')
      .in('match_id', idsDiffuses)
      .neq('status', 'postponed')
      .neq('status', 'finished');

    if (!matchsAttendus?.length) {
      stats.skipped = true;
      return new Response(
        JSON.stringify({ success: true, message: 'Aucun match en direct — aucun appel API.', ...stats }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    stats.matchsLive = matchsAttendus.length;
    const matchsModifies: MatchChange[] = [];

    // ── Étape 2 : SofaScore en premier (source principale, sans clé ni quota) ────
    // 1 seul appel couvre tout le football mondial en direct — on l'essaie
    // d'abord pour tous les matchs suivis, y compris ceux sans id_thesportsdb
    // (ex : importés via Odds API, qui ne donne pas de détails live).
    stats.source = 'sofascore';
    try {
      const sofaEvents = await getLiveEventsSofascore();
      for (const match of matchsAttendus) {
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
    