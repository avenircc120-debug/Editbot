/**
 * fetch-matches — Ingestion des scores en direct
 *
 * Source unique : TheSportsDB (480 appels/jour)
 *   → eventsday.php : 1 appel = tous les matchs du monde pour une date.
 *
 * L'ancien fallback "The Odds API" a été retiré : son quota (55 appels/jour)
 * était systématiquement épuisé dès le matin alors que TheSportsDB, lui,
 * ne l'était pas — il n'apportait donc plus rien, juste du bruit ("odds_...")
 * et de la complexité. Les matchs en direct restent couverts rapidement par
 * ESPN via live-cron (voir supabase/functions/live-cron/index.ts).
 *
 * Fréquence cron : toutes les 4 minutes.
 * Sécurité       : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { consommerQuota, lireQuotas } from '../_shared/quota.ts';
import {
  getMatchsDuJour,
  getEvenementDetails,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_EVENEMENTS_PAR_JOUR = 1500;

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function normaliserStatus(strStatus: string | undefined): string {
  switch ((strStatus ?? '').toUpperCase()) {
    case 'FT': case 'AET': case 'PEN': return 'finished';
    case 'HT': case '1H': case '2H': case 'ET': return 'inprogress';
    case 'PST': case 'CANC': case 'ABD': return 'postponed';
    default: return 'scheduled';
  }
}

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Indexation TheSportsDB ───────────────────────────────────────────────────

async function indexerMatch(ev: TsdbMatch, competition: string): Promise<{ matchId: string; changed: boolean; row: any } | null> {
  if (!ev.strHomeTeam || !ev.strAwayTeam) return null;
  const matchDate  = tsdbTimestampToDate(ev.strTimestamp).toISOString();
  const status     = normaliserStatus(ev.strStatus);
  const rawStatus  = (ev.strStatus ?? 'NS').toUpperCase();
  const homeScore  = ev.intHomeScore != null ? Number(ev.intHomeScore) : null;
  const awayScore  = ev.intAwayScore != null ? Number(ev.intAwayScore) : null;

  const { data: avant } = await supabase
    .from('matchs_index')
    .select('status, home_score, away_score, raw_status')
    .eq('match_id', ev.idEvent)
    .maybeSingle();

  const prevRaw = (avant?.raw_status ?? '').toUpperCase();

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:        ev.idEvent,
    home_team:       ev.strHomeTeam,
    away_team:       ev.strAwayTeam,
    home_team_id:    ev.idHomeTeam ?? null,
    away_team_id:    ev.idAwayTeam ?? null,
    competition,
    tournament_id:   ev.idLeague ?? null,
    season_id:       ev.strSeason ?? null,
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

  if (error) {
    console.warn('[index]', ev.idEvent, error.message);
    return null;
  }

  // ── Détection du type d'événement ────────────────────────────────────────
  const butMarque  = avant && status === 'inprogress'
    && (avant.home_score !== homeScore || avant.away_score !== awayScore);
  const coupEnvoi  = avant && avant.status === 'scheduled' && status === 'inprogress';
  const miTemps    = rawStatus === 'HT' && prevRaw !== 'HT';
  const finMatch   = status === 'finished' && avant?.status !== 'finished';

  let eventType = 'update';
  if (butMarque)  eventType = 'goal';
  else if (coupEnvoi) eventType = 'kickoff';
  else if (miTemps)   eventType = 'halftime';
  else if (finMatch)  eventType = 'fulltime';

  // ── Récupération buteurs si but marqué ───────────────────────────────────
  let homeGoalDetails: string | null = null;
  let awayGoalDetails: string | null = null;
  let matchMinute: number | null = null;

  if (butMarque) {
    const quotaOk = await consommerQuota(supabase, 'thesportsdb');
    if (quotaOk) {
      const det = await getEvenementDetails(ev.idEvent);
      if (det) {
        homeGoalDetails = det.homeGoalDetails;
        awayGoalDetails = det.awayGoalDetails;
        matchMinute     = det.minute;
        await supabase.from('matchs_index')
          .update({ home_goal_details: homeGoalDetails, away_goal_details: awayGoalDetails, match_minute: matchMinute })
          .eq('match_id', ev.idEvent);
      }
    }
  }

  // Si mi-temps ou fin : récupérer les buteurs depuis la DB pour le résumé
  if ((miTemps || finMatch) && !homeGoalDetails) {
    const { data: idx } = await supabase
      .from('matchs_index')
      .select('home_goal_details, away_goal_details, match_minute')
      .eq('match_id', ev.idEvent)
      .maybeSingle();
    homeGoalDetails = idx?.home_goal_details ?? null;
    awayGoalDetails = idx?.away_goal_details ?? null;
    matchMinute     = idx?.match_minute ?? null;
  }

  // ── Décision de diffusion ─────────────────────────────────────────────────
  const evenementSignificatif = ['goal', 'kickoff', 'halftime', 'fulltime'].includes(eventType);
  const scoresDispo = homeScore !== null && awayScore !== null;
  const enDirectOuTermine = status === 'inprogress' || status === 'finished';

  return {
    matchId: ev.idEvent,
    changed: evenementSignificatif && enDirectOuTermine && scoresDispo,
    row: {
      matchId:         ev.idEvent,
      competition,
      homeTeam:        ev.strHomeTeam,
      awayTeam:        ev.strAwayTeam,
      homeScore,
      awayScore,
      status,
      rawStatus,
      eventType,
      homeGoalDetails,
      awayGoalDetails,
      minute:          matchMinute,
    },
  };
}

async function ingererJournee(dateStr: string, stats: { indexes: number; erreurs: number }, matchsAModifier: any[]): Promise<boolean> {
  const ok = await consommerQuota(supabase, 'thesportsdb');
  if (!ok) {
    console.warn('[fetch-matches] Quota thesportsdb épuisé — arrêt pour cette exécution');
    return false;
  }

  try {
    const evenements = (await getMatchsDuJour(dateStr) ?? []).slice(0, MAX_EVENEMENTS_PAR_JOUR);
    for (const ev of evenements) {
      const res = await indexerMatch(ev, ev.strLeague || 'Autre compétition');
      if (!res) { stats.erreurs++; continue; }
      stats.indexes++;
      if (res.changed) matchsAModifier.push(res.row);
    }
  } catch (e) {
    console.error('[fetch-matches] Erreur ingestion', dateStr, e);
    stats.erreurs++;
  }

  return true;
}

// ─── Diffusion Facebook ───────────────────────────────────────────────────────

async function diffuserSurFacebook(matches: any[]) {
  if (!matches.length) return;
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/facebook-post`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ matches }),
    });
  } catch (e) {
    console.error('[fetch-matches] Erreur appel facebook-post:', e);
  }
}

/** Désactive les diffusions des matchs terminés — appelé APRÈS diffuserSurFacebook
 *  pour que le dernier post (score final) soit bien envoyé avant que
 *  broadcast_selections.is_active passe à false (sinon facebook-post ne
 *  trouve plus la sélection et le score final n'est jamais publié). */
async function desactiverMatchsTermines(matches: any[]) {
  const matchIds = matches.filter((m) => m.eventType === 'fulltime').map((m) => m.matchId);
  if (!matchIds.length) return;
  await supabase
    .from('broadcast_selections')
    .update({ is_active: false })
    .in('match_id', matchIds);
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const stats = { indexes: 0, erreurs: 0, diffuses: 0 };
  const matchsAModifier: any[] = [];
  const now = new Date();

  // ── TheSportsDB (source primaire) ─────────────────────────────────────────
  const continuer = await ingererJournee(dateISO(now), stats, matchsAModifier);

  // Une fois par heure : hier + 7 prochains jours (programme proche).
  if (continuer && now.getUTCMinutes() < 4) {
    for (const decalage of [-1, 1, 2, 3, 4, 5, 6, 7]) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
    }
  }

  // Une fois par jour à 2h UTC : fenêtre glissante 30 jours (futurs J+8..J+30 + passés J-1..J-7)
  if (continuer && now.getUTCHours() === 2 && now.getUTCMinutes() < 4) {
    // Jours futurs J+8 à J+30 (programme étendu)
    for (let decalage = 8; decalage <= 30; decalage++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
    }
    // Jours passés J-1 à J-7 (résultats récents — upsert met à jour les scores finaux)
    for (let decalage = 1; decalage <= 7 && continuer; decalage++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
    }
  }

  // Une fois par jour à 3h UTC : historique profond J-8 à J-30
  if (continuer && now.getUTCHours() === 3 && now.getUTCMinutes() < 4) {
    for (let decalage = 8; decalage <= 30 && continuer; decalage++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
    }
  }

  if (!continuer) {
    console.log('[fetch-matches] Quota TheSportsDB épuisé pour aujourd’hui — arrêt jusqu’à demain.');
  }

  await diffuserSurFacebook(matchsAModifier);
  await desactiverMatchsTermines(matchsAModifier);
  stats.diffuses = matchsAModifier.length;

  const quotas = await lireQuotas(supabase);

  return new Response(
    JSON.stringify({ success: true, ...stats, quotas, timestamp: new Date().toISOString() }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
