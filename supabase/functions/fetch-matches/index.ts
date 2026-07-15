/**
 * fetch-matches — Ingestion des scores en direct (TheSportsDB)
 *
 * Récupère TOUS les matchs de football de la journée (toutes compétitions
 * confondues, via eventsday.php) et les indexe dans matchs_index (source de
 * vérité des scores en direct, conservée intégralement).
 *
 * Pourquoi "par jour" et non "par ligue" : eventsday.php renvoie en 1 seul
 * appel API tous les matchs du monde entier pour une date donnée, peu importe
 * la compétition. Ça permet de couvrir absolument toutes les ligues sans
 * multiplier les appels (contrairement à l'ancienne version qui faisait
 * 2 appels par ligue suivie et finissait par épuiser le quota journalier
 * en ~1h, laissant le bot "silencieux" le reste de la journée).
 *
 * Fréquence : ce job tourne toutes les 4 minutes et ré-indexe "aujourd'hui"
 * à chaque passage (1 appel = les scores en direct + le programme du jour
 * à jour en quasi temps réel). Une fois par heure, il élargit aussi la
 * fenêtre à hier + les 3 prochains jours (4 appels de plus) pour garder le
 * programme à jour, sans jamais dépasser le quota gratuit de 500 appels/jour.
 *
 * Dès qu'un score/statut change sur un match, déclenche immédiatement
 * facebook-post pour diffuser ce match aux Pages Facebook concernées.
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { consommerQuota, lireQuotas } from '../_shared/quota.ts';
import {
  getMatchsDuJour,
  tsdbTimestampToDate,
  type TsdbMatch,
} from '../_shared/thesportsdb.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

// Garde-fou : nombre max de matchs traités par appel eventsday (sécurité, pas
// une limite fonctionnelle — une journée de foot mondiale reste bien en dessous).
const MAX_EVENEMENTS_PAR_JOUR = 1500;

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

async function indexerMatch(ev: TsdbMatch, competition: string): Promise<{ matchId: string; changed: boolean; row: any } | null> {
  if (!ev.strHomeTeam || !ev.strAwayTeam) return null;
  const matchDate = tsdbTimestampToDate(ev.strTimestamp).toISOString();
  const status    = normaliserStatus(ev.strStatus);
  const homeScore = ev.intHomeScore !== null && ev.intHomeScore !== undefined ? Number(ev.intHomeScore) : null;
  const awayScore = ev.intAwayScore !== null && ev.intAwayScore !== undefined ? Number(ev.intAwayScore) : null;

  const { data: avant } = await supabase
    .from('matchs_index')
    .select('status, home_score, away_score')
    .eq('match_id', ev.idEvent)
    .maybeSingle();

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

  const changed = !avant
    || avant.status    !== status
    || avant.home_score !== homeScore
    || avant.away_score !== awayScore;

  const enDirectOuTermine = status === 'inprogress' || status === 'finished';

  return {
    matchId: ev.idEvent,
    changed:  changed && enDirectOuTermine && homeScore !== null && awayScore !== null,
    row: { matchId: ev.idEvent, competition, homeTeam: ev.strHomeTeam, awayTeam: ev.strAwayTeam, homeScore, awayScore, status },
  };
}

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

/** Ingère toutes les compétitions pour une journée donnée (1 appel API). */
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

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const stats = { indexes: 0, erreurs: 0, diffuses: 0 };
  const matchsAModifier: any[] = [];
  const now = new Date();

  // Aujourd'hui : à chaque exécution (toutes les 4 min) → scores en direct
  // et programme du jour quasi temps réel, pour TOUTES les compétitions.
  const continuer = await ingererJournee(dateISO(now), stats, matchsAModifier);

  // Une fois par heure : élargit à hier + les 3 prochains jours pour garder
  // le programme à jour (résultats de fin de journée, matchs à venir).
  if (continuer && now.getUTCMinutes() < 4) {
    for (const decalage of [-1, 1, 2, 3]) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + decalage);
      const ok = await ingererJournee(dateISO(d), stats, matchsAModifier);
      if (!ok) break;
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
