/**
 * ─── MASAP fetch-odds ─────────────────────────────────────────────────────────
 * Edge Function — Mise à jour des cotes via The Odds API
 *
 * Stratégie (revue) :
 * 1. Lit matchs_index pour les matchs à venir dans les 48h (source réelle des
 *    matchs, alimentée par fetch-matches — remplace whitelist_matchs qui
 *    n'était jamais peuplée).
 * 2. Groupe les matchs par compétition, 1 seul appel The Odds API par ligue
 *    active (renvoie tous les matchs de la ligue avec cotes en un coup).
 * 3. Associe chaque match interne à son événement par nom d'équipes + horaire.
 * 4. Normalise via market-mapper et upsert dans marches_bookmakers.
 *
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 * Quota The Odds API : 500 req/mois (gratuit) → appelée peu fréquemment
 * (recommandé : toutes les 3-6h, pas toutes les 10 min).
 */

import { createClient }        from 'npm:@supabase/supabase-js@2';
import { LEAGUES }             from '../_shared/config.ts';
import { consommerQuotaStrict } from '../_shared/quota.ts';
import {
  fetchOddsForLeague,
  trouverEventOdds,
  construireOddsResult,
} from '../_shared/odds.ts';

const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Fenêtre de refresh : matchs dans les prochaines 48h seulement
const HORIZON_HEURES = 48;

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_HEURES * 3600 * 1000);

  const stats = {
    ligues_evaluees:  0,
    ligues_appelees:  0,
    matchs_evalues:   0,
    matchs_refreshes: 0,
    matchs_sans_cote: 0,
    quota_epuise:     false,
    erreurs:          0,
  };

  // ─── 1. Charger les matchs à venir depuis matchs_index ────────────────────

  const { data: matchs, error: mErr } = await supabase
    .from('matchs_index')
    .select('match_id, home_team, away_team, competition, match_date')
    .eq('status', 'scheduled')
    .lte('match_date', horizon.toISOString())
    .gte('match_date', now.toISOString());

  if (mErr) {
    console.error('[fetch-odds] Erreur lecture matchs_index:', mErr.message);
    return new Response(JSON.stringify({ success: false, error: mErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!matchs || matchs.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'Aucun match à venir', stats }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── 2. Grouper par compétition ────────────────────────────────────────────

  const parCompetition = new Map<string, typeof matchs>();
  for (const m of matchs) {
    if (!parCompetition.has(m.competition)) parCompetition.set(m.competition, []);
    parCompetition.get(m.competition)!.push(m);
  }

  // ─── 3. Pour chaque ligue avec des matchs à venir, 1 appel The Odds API ───

  for (const [competition, matchsLigue] of parCompetition) {
    stats.ligues_evaluees++;
    stats.matchs_evalues += matchsLigue.length;

    const league = LEAGUES.find((l) => l.name === competition);
    if (!league?.odds_key) {
      stats.matchs_sans_cote += matchsLigue.length;
      continue;
    }

    const quotaOk = await consommerQuotaStrict(supabase, 'odds' as any);
    if (!quotaOk) {
      console.warn('[fetch-odds] 🛑 Quota odds épuisé');
      stats.quota_epuise = true;
      break;
    }

    let events: Awaited<ReturnType<typeof fetchOddsForLeague>> = [];
    try {
      events = await fetchOddsForLeague(league.odds_key);
      stats.ligues_appelees++;
    } catch (e) {
      console.error('[fetch-odds] Erreur ligue', competition, e);
      stats.erreurs++;
      continue;
    }

    if (!events.length) {
      stats.matchs_sans_cote += matchsLigue.length;
      continue;
    }

    // ─── 4. Associer + upsert pour chaque match de cette ligue ──────────────

    for (const match of matchsLigue) {
      const ev = trouverEventOdds(events, match.home_team, match.away_team, match.match_date);
      if (!ev) {
        stats.matchs_sans_cote++;
        continue;
      }

      const result = construireOddsResult(match.match_id, ev);
      if (!result) {
        stats.matchs_sans_cote++;
        continue;
      }

      const { error: upsertErr } = await supabase
        .from('marches_bookmakers')
        .upsert(
          {
            match_id:       match.match_id,
            nom_bookmaker:  result.bookmakerName,
            bookmaker_id:   0,
            marche_donnees: result.donnees,
            updated_at:     now.toISOString(),
          },
          { onConflict: 'match_id,nom_bookmaker' },
        );

      if (upsertErr) {
        console.error(`[fetch-odds] Upsert error ${match.match_id}:`, upsertErr.message);
        stats.erreurs++;
        continue;
      }

      stats.matchs_refreshes++;
      const nbMarches = Object.keys(result.donnees.marches).length;
      console.log(
        `[fetch-odds] ✅ ${match.home_team} vs ${match.away_team}` +
        ` | ${result.bookmakerName} | ${nbMarches} marchés`
      );
    }
  }

  return new Response(
    JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
