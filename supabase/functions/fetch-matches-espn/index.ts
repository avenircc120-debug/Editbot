/**
 * fetch-matches-espn — Ingestion de matchs directement depuis ESPN
 *
 * Complète fetch-matches (TheSportsDB) pour les compétitions déjà mappées
 * dans ESPN_LEAGUE_SLUGS : la clé TheSportsDB de test ("123") ne renvoie
 * qu'un échantillon très limité (~3 événements/jour dans le monde, vérifié
 * en réel le 12/09/2026, contre 1000+ matchs réels ce jour-là selon des
 * sites de programme foot) et rate la quasi-totalité des grandes
 * compétitions.
 *
 * Contrairement à live-cron (qui ne fait que METTRE À JOUR des matchs déjà
 * présents dans matchs_index), cette fonction interroge ESPN directement
 * (via le proxy Cloudflare — seul chemin non bloqué par réputation IP,
 * vérifié avec pg_net : ESPN bloque tout le reste de l'infra Supabase) pour
 * CRÉER les matchs manquants.
 *
 * Limites connues :
 *  - Uniquement les compétitions déjà dans ESPN_LEAGUE_SLUGS (pas de
 *    découverte automatique — ESPN n'a pas d'équivalent au eventsday.php
 *    de TheSportsDB, vérifié empiriquement : ni /standings ni /scoreboard
 *    sans compétition ne renvoient de données exploitables).
 *  - Risque de doublon si TheSportsDB retrouve un jour le même match sous
 *    un autre match_id (numérique tsdb vs "espn-{id}" ici) — accepté pour
 *    l'instant vu la quasi-absence de couverture TheSportsDB actuelle.
 *  - home_team_id/away_team_id volontairement laissés NULL : ce sont des
 *    ID ESPN, pas TheSportsDB, et le matching "équipe favorite"
 *    (auto-broadcast) compare par ID TheSportsDB — les mélanger casserait
 *    ce matching silencieusement.
 *
 * Fréquence cron : toutes les 15 minutes (alignée sur fetch-matches).
 * Sécurité : header Authorization: Bearer {CRON_SECRET}
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { LEAGUES } from '../_shared/config.ts';
import {
  getEspnMatchesForIngestion,
  statutEspnVersInterne,
  scoreEspn,
  clockEspn,
  ESPN_LEAGUE_SLUGS,
  type EspnEvent,
} from '../_shared/espn.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const NOM_PAR_TSDB_ID: Record<string, string> = Object.fromEntries(LEAGUES.map((l) => [l.tsdb_id, l.name]));

function dateEspn(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function indexerMatchEspn(tsdbId: string, event: EspnEvent): Promise<boolean> {
  const competitors = event.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home?.team?.displayName || !away?.team?.displayName) return false;

  const status = statutEspnVersInterne(event.status?.type?.state ?? '');
  const matchId = `espn-${event.id}`;
  const matchDate = event.date ?? new Date().toISOString();

  const { error } = await supabase.from('matchs_index').upsert({
    match_id:      matchId,
    home_team:     home.team.displayName,
    away_team:     away.team.displayName,
    competition:   NOM_PAR_TSDB_ID[tsdbId] ?? tsdbId,
    tournament_id: tsdbId,
    match_date:    matchDate,
    status,
    raw_status:    clockEspn(event) ?? event.status?.type?.description ?? 'NS',
    home_score:    scoreEspn(event, 'home'),
    away_score:    scoreEspn(event, 'away'),
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'match_id' });

  if (error) {
    console.warn('[fetch-matches-espn] upsert', matchId, error.message);
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const stats = { indexes: 0, erreurs: 0, competitionsInterrogees: Object.keys(ESPN_LEAGUE_SLUGS).length };
  const now = new Date();

  // Aujourd'hui + 2 jours suivants : suffisant pour la découverte proche
  // sans multiplier les appels proxy Cloudflare (20 compétitions x 3 jours
  // = 60 appels max par exécution, déjà plafonnés à 4 en parallèle par
  // getEspnMatchesForIngestion).
  for (const decalage of [0, 1, 2]) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + decalage);

    try {
      const matches = await getEspnMatchesForIngestion(dateEspn(d));
      for (const { tsdbId, event } of matches) {
        const ok = await indexerMatchEspn(tsdbId, event);
        if (ok) stats.indexes++; else stats.erreurs++;
      }
    } catch (e) {
      console.error('[fetch-matches-espn] erreur jour', dateEspn(d), e);
      stats.erreurs++;
    }
  }

  return new Response(
    JSON.stringify({ success: true, ...stats, timestamp: now.toISOString() }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
