/**
 * ─── MASAP fetch-odds ─────────────────────────────────────────────────────────
 * Edge Function — Mise à jour sélective des cotes toutes les 10 minutes
 *
 * Stratégie :
 * 1. Lit la whitelist_matchs (matchs actifs à venir dans les 48h)
 * 2. Pour chaque match éligible (intervalle de refresh écoulé), fetch /odds
 * 3. Normalise via market-mapper et upsert dans marches_bookmakers
 * 4. Met à jour dernier_refresh dans whitelist_matchs
 * 5. Rafraîchit la vue matérialisée meilleure_cote_par_match
 *
 * Appelée par le CRON Supabase toutes les 10 minutes :
 *   schedule: every 10 minutes (cron: star-slash-10 star star star)
 */

import { serve }                         from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient }                  from 'https://esm.sh/@supabase/supabase-js@2';
import { consommerQuotaStrict }          from '../_shared/quota.ts';
import { fetchOdds }                     from '../_shared/odds.ts';

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Fenêtre de refresh : matchs dans les prochaines 48h seulement
const HORIZON_HEURES = 48;

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Auth CRON — fail-closed si secret absent ou incorrect
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_HEURES * 3600 * 1000);

  const stats = {
    matchs_evalues:  0,
    matchs_refreshes: 0,
    matchs_skips:    0,
    quota_epuise:    false,
    erreurs:         0,
  };

  // ─── 1. Charger la whitelist ──────────────────────────────────────────────

  const { data: whitelist, error: wErr } = await supabase
    .from('whitelist_matchs')
    .select('*')
    .eq('actif', true)
    .lte('match_date', horizon.toISOString())   // dans les 48h
    .gte('match_date', now.toISOString())       // pas encore joué
    .order('match_date', { ascending: true });

  if (wErr) {
    console.error('[fetch-odds] Erreur lecture whitelist:', wErr.message);
    return new Response(JSON.stringify({ success: false, error: wErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!whitelist || whitelist.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'Whitelist vide', stats }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[fetch-odds] ${whitelist.length} matchs en whitelist`);

  // ─── 2. Boucle sur chaque match éligible ─────────────────────────────────

  for (const match of whitelist) {
    stats.matchs_evalues++;

    if (!match.fixture_apif_id) {
      console.warn(`[fetch-odds] Pas de fixture_apif_id pour ${match.match_id}`);
      stats.matchs_skips++;
      continue;
    }

    // ── Claim atomique anti-race ──────────────────────────────────────────────
    // On tente d'écrire dernier_refresh = NOW() uniquement si la ligne n'a pas
    // déjà été réclamée par une exécution concurrente dans l'intervalle requis.
    const intervalleMin = match.intervalle_refresh_min ?? 10;
    const cutoffRefresh = new Date(now.getTime() - intervalleMin * 60 * 1000).toISOString();

    const { count: claimed } = await supabase
      .from('whitelist_matchs')
      .update({ dernier_refresh: now.toISOString() })
      .eq('id', match.id)
      .or(`dernier_refresh.is.null,dernier_refresh.lt.${cutoffRefresh}`)
      // count: 'exact' pour savoir si la ligne a vraiment été mise à jour
      .select('id', { count: 'exact', head: true });

    if (!claimed || claimed === 0) {
      // Une autre instance a déjà réclamé ce match → skip
      stats.matchs_skips++;
      continue;
    }

    // Consomme le quota 'odds' (fail-closed pour protéger le budget)
    const ok = await consommerQuotaStrict(supabase, 'odds');
    if (!ok) {
      console.warn('[fetch-odds] 🛑 Quota odds épuisé');
      stats.quota_epuise = true;
      // Annule le claim pour que la prochaine exécution puisse le traiter
      await supabase
        .from('whitelist_matchs')
        .update({ dernier_refresh: match.dernier_refresh ?? null })
        .eq('id', match.id);
      break;
    }

    // ─── 3. Fetch les cotes ─────────────────────────────────────────────────

    try {
      const result = await fetchOdds(match.fixture_apif_id);

      if (!result) {
        stats.erreurs++;
        continue;
      }

      // ─── 4. Upsert dans marches_bookmakers ───────────────────────────────

      const { error: upsertErr } = await supabase
        .from('marches_bookmakers')
        .upsert(
          {
            match_id:      match.match_id,
            nom_bookmaker: result.bookmakerName,
            bookmaker_id:  result.bookmakerId,
            marche_donnees: result.donnees,
            updated_at:    now.toISOString(),
          },
          { onConflict: 'match_id,nom_bookmaker' }
        );

      if (upsertErr) {
        console.error(`[fetch-odds] Upsert error ${match.match_id}:`, upsertErr.message);
        stats.erreurs++;
        continue;
      }

      // ─── 5. Mise à jour dernier_refresh ──────────────────────────────────

      await supabase
        .from('whitelist_matchs')
        .update({ dernier_refresh: now.toISOString() })
        .eq('id', match.id);

      stats.matchs_refreshes++;

      const nbMarches = Object.keys(result.donnees.marches).length;
      console.log(
        `[fetch-odds] ✅ ${match.equipe_domicile} vs ${match.equipe_exterieur}` +
        ` | ${result.bookmakerName} | ${nbMarches} marchés`
      );

    } catch (e) {
      console.error(`[fetch-odds] Exception ${match.match_id}:`, e);
      stats.erreurs++;
    }
  }

  // ─── 6. Rafraîchir la vue matérialisée ───────────────────────────────────

  if (stats.matchs_refreshes > 0) {
    try {
      await supabase.rpc('rafraichir_meilleures_cotes');
    } catch (e) {
      // Vue pas critique — pas d'erreur fatale
      console.warn('[fetch-odds] Vue matérialisée non rafraîchie:', e);
    }
  }

  return new Response(
    JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
