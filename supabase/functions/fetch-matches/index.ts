/**
 * fetch-matches — Ingestion des scores en direct
 *
 * Source primaire   : TheSportsDB (500 appels/jour)
 *   → eventsday.php : 1 appel = tous les matchs du monde pour une date.
 *
 * Source secondaire : The Odds API (55 appels/jour) — fallback automatique
 *   → Activé quand le quota TheSportsDB est épuisé.
 *   → Limité à 2 fenêtres/heure (:00 et :30) pour économiser le quota.
 *   → Couvre scores en direct + résultats récents + calendrier à venir.
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
import { getAllMatchsFallback, type OddsMatchRow } from '../_shared/odds.ts';

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

// ─── Indexation Odds API (fallback) ──────────────────────────────────────────

async function indexerMatchOdds(ev: OddsMatchRow): Promise<{ changed: boolean; row: any } | null> {
  if (!ev.home_team || !ev.away_team) return null;

  const { data: avant } = await supabase
    .from('matchs_index')
    .select('status, home_score, away_score, raw_status')
    .eq('match_id', ev.match_id)
    .maybeSingle();

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:      ev.match_id,
    home_team:     ev.home_team,
    away_team:     ev.away_team,
    competition:   ev.competition,
    tournament_id: ev.tournament_id,
    match_date:    ev.match_date,
    status:        ev.status,
    home_score:    ev.home_score,
    away_score:    ev.away_score,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'match_id' });

  if (error) {
    console.warn('[odds-index]', ev.match_id, error.message);
    return null;
  }

  const butMarque = avant && ev.status === 'inprogress'
    && (avant.home_score !== ev.home_score || avant.away_score !== ev.away_score);
  const coupEnvoi = avant && avant.status === 'scheduled' && ev.status === 'inprogress';
  const finMatch  = ev.status === 'finished' && avant?.status !== 'finished';

  let eventType = 'update';
  if (butMarque)      eventType = 'goal';
  else if (coupEnvoi) eventType = 'kickoff';
  else if (finMatch)  eventType = 'fulltime';

  const evenementSignificatif = ['goal', 'kickoff', 'fulltime'].includes(eventType);
  const enDirectOuTermine = ev.status === 'inprogress' || ev.status === 'finished';

  return {
    changed: evenementSignificatif && enDirectOuTermine && ev.home_score !== null && ev.away_score !== null,
    row: {
      matchId:         ev.match_id,
      competition:     ev.competition,
      homeTeam:        ev.home_team,
      awayTeam:        ev.away_team,
      homeScore:       ev.home_score,
      awayScore:       ev.away_score,
      status:          ev.status,
      rawStatus:       null,
      eventType,
      homeGoalDetails: null,
      awayGoalDetails: null,
      minute:          null,
    },
  };
}

async function ingererFallbackOdds(stats: { indexes: number; erreurs: number; fallback: boolean }, matchsAModifier: any[]): Promise<void> {
  console.log('[fetch-matches] TheSportsDB épuisé → activation fallback Odds API');
  stats.fallback = true;

  const consommer = (api: string) => consommerQuota(supabase, api as any);
  const matchs = await getAllMatchsFallback(consommer);

  for (const ev of matchs) {
    const res = await indexerMatchOdds(ev);
    if (!res) { stats.erreurs++; continue; }
    stats.indexes++;
    if (res.changed) matchsAModifier.push(res.row);
  }
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

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const stats = { indexes: 0, erreurs: 0, diffuses: 0, fallback: false };
  const matchsAModifier: any[] = [];
  const now = new Date();

  // ── TheSportsDB (source primaire) ─────────────────────────────────────────
  const continuer = await ingererJournee(dateISO(now), stats, matchsAModifier);

  // Une fois par heure : hier + 3 prochains jours (programme complet).
  if (continuer && now.getUTCMinutes() < 4) {
    for (const decalage of [-1, 1, 2, 3]) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
    }
  }

  // ── Odds API ─────────────────────────────────────────────────────────────
  // 1) TheSportsDB épuisé → fallback automatique (fenêtre :00-:03 / :30-:33)
  // 2) TheSportsDB OK mais broadcasts avec ID odds_... actifs → check complémentaire
  //    (même fenêtre, pour rester dans les 55 appels/jour)
  const min = now.getUTCMinutes();
  const estFenetreOdds = min < 4 || (min >= 30 && min < 34);

  if (!continuer) {
    if (estFenetreOdds) {
      await ingererFallbackOdds(stats, matchsAModifier);
    } else {
      console.log('[fetch-matches] TheSportsDB épuisé — hors fenêtre Odds API, skip.');
    }
  } else if (estFenetreOdds) {
    // TheSportsDB OK : vérifier si des broadcasts odds_... actifs (ex: MLS)
    const { count } = await supabase
      .from('broadcast_selections')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true)
      .like('match_id', 'odds_%');
    if ((count ?? 0) > 0) {
      console.log(`[fetch-matches] ${count} broadcast(s) odds_... actif(s) → Odds API complémentaire`);
      await ingererFallbackOdds(stats, matchsAModifier);
    }
  }

  await diffuserSurFacebook(matchsAModifier);
  stats.diffuses = matchsAModifier.length;

  const quotas = await lireQuotas(supabase);

  return new Response(
    JSON.stringify({ success: true, ...stats, quotas, timestamp: new Date().toISOString() }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
