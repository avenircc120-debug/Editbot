/**
    * live-cron — Cron intelligent pour les scores en direct
    *
    * Logique :
    *  0. Purge (SQL pur, sans appel externe) les matchs 'inprogress'/'scheduled'
    *     dont le coup d'envoi date de plus de 4h — ils sortiraient de la fenêtre
    *     de l'étape 1 et resteraient sinon bloqués "en direct" pour toujours.
    *  1. Interroge Supabase pour identifier TOUS les matchs (toutes compétitions,
    *     tous utilisateurs confondus) actuellement en direct (status = 'inprogress')
    *     OU dont le coup d'envoi est proche/passé (match_date entre -4h et +15min) —
    *     pas seulement ceux sélectionnés pour diffusion Facebook : SofaScore n'a
    *     ni clé ni quota, on peut se permettre de suivre tout le monde.
    *  2. Si aucun match candidat → sortie immédiate, AUCUN appel API externe.
    *  3. SofaScore (seule source, sans clé ni quota) → 1 seul appel couvre
    *     tout le football mondial en direct.
    *  4. Upsert DB + déclenche facebook-post (qui filtre lui-même par
    *     broadcast_selections.is_active) si score/statut changé.
    *  5. Un match 'inprogress' introuvable dans le direct SofaScore est
    *     considéré terminé (évite les matchs bloqués indéfiniment en direct).
    *
    * Fréquence cron recommandée : toutes les minutes (SofaScore : sans quota)
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
    const stats = { matchsLive: 0, matchsMisAJour: 0, matchsClotures: 0, matchsPurges: 0, source: '', skipped: false };

    // ── Étape 0 : Purge des matchs bloqués (aucun appel externe, coût nul) ────
    // Un match encore 'inprogress'/'scheduled' plus de 4h après son coup d'envoi
    // ne sera plus jamais repris par la fenêtre de l'étape 1 (il en est sorti) :
    // sans ce filet, un match bloqué (bug amont, source disparue, ID fantôme)
    // reste "en direct" indéfiniment dans la Mini App. On le clôture d'office.
    const seuilPurge = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const { data: purges } = await supabase
      .from('matchs_index')
      .update({ status: 'finished', raw_status: 'FT (auto)', updated_at: now.toISOString() })
      .in('status', ['inprogress', 'scheduled'])
      .lt('match_date', seuilPurge)
      .select('match_id');
    stats.matchsPurges = purges?.length ?? 0;

    // ── Étape 1 : Identifier tous les matchs en direct ou dont le coup d'envoi
    // est imminent/passé récemment ────────────────────────────────
    // SofaScore couvre tout le football mondial en 1 seul appel, sans clé ni
    // quota : pas besoin de restreindre aux matchs diffusés sur Facebook.
    // Fenêtre : -4h (durée max d'un match + arrêt de jeu) → +15min (imminents).
    const fenetreDebut = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const fenetreFin   = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    const { data: matchsAttendus } = await supabase
      .from('matchs_index')
      .select('match_id, status, id_thesportsdb, competition, home_team, away_team, home_score, away_score, match_date')
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

    // ── Étape 2 : SofaScore (seule source, sans clé ni quota) ──────────────
    // 1 seul appel couvre tout le football mondial en direct.
    stats.source = 'sofascore';
    let sofaEvents: Awaited<ReturnType<typeof getLiveEventsSofascore>> = [];
    try {
      sofaEvents = await getLiveEventsSofascore();
    } catch (e) {
      console.warn('[live-cron] Erreur SofaScore:', e);
    }

    // Garde-fou : si SofaScore renvoie une liste anormalement courte (panne API,
    // 403, etc.), on ne déclare AUCUN match "terminé par déduction" pour éviter
    // de clôturer massivement des matchs réellement en cours.
    const sofaFiable = sofaEvents.length >= 10;

    for (const match of matchsAttendus) {
      const found = trouverEvenementSofascore(sofaEvents, match.home_team, match.away_team);

      if (found) {
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
        continue;
      }

      // Pas trouvé dans le direct SofaScore : un match qu'on avait en 'inprogress'
      // et qui a disparu du flux est très probablement terminé → on le clôture
      // pour ne pas le laisser bloqué indéfiniment dans l'onglet "En direct".
      if (sofaFiable && match.status === 'inprogress') {
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

    // ── Étape 3 : Diffuser sur Facebook si changement ────────────────────────────
    await diffuserSurFacebook(matchsModifies);

    return new Response(
      JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    });
    