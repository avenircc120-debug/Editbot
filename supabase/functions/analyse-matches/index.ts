/**
 * analyse-matches v3 — Cycle complet fetch → Groq → pronostics_pre_calcules
 *
 * Lit matchs_index + marches_bruts (sources : thesportsdb + sofascore),
 * construit un contexte enrichi pour Groq, génère 4 pronostics par match.
 *
 * Nouveaux slugs gérés dans buildContext :
 *   tsdb_event  → données brutes TheSportsDB (équipes, compétition, date)
 *   tsdb_stats  → stats post-match TheSportsDB (tirs cadrés/non-cadrés…)
 *   lineups     → compositions d'équipes (TheSportsDB)
 *   h2h         → historique H2H (SofaScore)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { GROQ, SYSTEM_PROMPT }          from '../_shared/config.ts';
import { consommerQuota, lireQuotas }   from '../_shared/quota.ts';
import { resumeOddsGroq }               from '../_shared/odds.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY     = Deno.env.get('GROQ_API_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_MATCHS = 10;
const TYPES      = ['1X2', 'BTTS', 'Over/Under 2.5', 'Double Chance'];

// ─── Construction du contexte enrichi pour Groq ───────────────────────────────

function buildContext(match: any, marches: any[]): string {
  const lignes: string[] = [
    `Match      : ${match.home_team} vs ${match.away_team}`,
    `Compétition: ${match.competition}`,
    `Date       : ${new Date(match.match_date).toLocaleDateString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    })}`,
    '',
    '=== DONNÉES DISPONIBLES ===',
  ];

  // Index des marchés par slug pour accès rapide
  const par: Record<string, any> = {};
  for (const m of marches) par[m.marche_slug] = m.donnees;

  // ── Stats de base TheSportsDB (tirs cadrés / non-cadrés / bloqués) ──────────
  if (par['tsdb_stats']?.eventstats?.length) {
    lignes.push('\n--- STATS DE BASE (TheSportsDB) ---');
    try {
      const stats: Array<{ strStat: string; intHome: string; intAway: string }> =
        par['tsdb_stats'].eventstats;
      for (const s of stats.slice(0, 10)) {
        lignes.push(`${s.strStat}: ${s.intHome} / ${s.intAway} (dom/ext)`);
      }
    } catch { /* ignoré */ }
  }

  // ── Lineups (TheSportsDB) ────────────────────────────────────────────────────
  if (par['lineups']?.lineup?.length) {
    lignes.push('\n--- COMPOSITIONS ---');
    try {
      const lineup = par['lineups'].lineup as Array<{
        strTeam: string; strPosition: string; strPlayer: string; strSubstitute: string;
      }>;
      const homeXI = lineup
        .filter(p => p.strTeam === match.home_team && p.strSubstitute === 'No')
        .map(p => `${p.strPosition}: ${p.strPlayer}`)
        .slice(0, 11);
      const awayXI = lineup
        .filter(p => p.strTeam === match.away_team && p.strSubstitute === 'No')
        .map(p => `${p.strPosition}: ${p.strPlayer}`)
        .slice(0, 11);

      if (homeXI.length) lignes.push(`${match.home_team}: ${homeXI.join(', ')}`);
      if (awayXI.length) lignes.push(`${match.away_team}: ${awayXI.join(', ')}`);
    } catch { /* ignoré */ }
  }

  // ── Historique H2H (SofaScore) ─────────────────────────────────────────────────
  if (par['h2h']?.events?.length || par['h2h']?.response?.length) {
    lignes.push('\n--- HISTORIQUE H2H ---');
    try {
      // Format SofaScore (legacy)
      const evts: any[] = par['h2h']?.events ?? par['h2h']?.response ?? [];
      evts.slice(0, 6).forEach((e: any) => {
        // SofaScore format
        if (e.homeTeam?.name) {
          const yr  = new Date((e.startTimestamp ?? 0) * 1000).getFullYear();
          const hsc = e.homeScore?.current ?? e.goals?.home ?? '?';
          const asc = e.awayScore?.current ?? e.goals?.away ?? '?';
          lignes.push(`${e.homeTeam.name} ${hsc}-${asc} ${e.awayTeam.name} (${yr})`);
        }
        // api-football format
        else if (e.teams?.home?.name) {
          const date = e.fixture?.date?.slice(0, 10) ?? '?';
          const hsc  = e.goals?.home ?? '?';
          const asc  = e.goals?.away ?? '?';
          lignes.push(`${e.teams.home.name} ${hsc}-${asc} ${e.teams.away.name} (${date})`);
        }
      });
    } catch { /* ignoré */ }
  }

  // ── Événement brut TheSportsDB (metadata si rien d'autre) ───────────────────
  if (par['tsdb_event'] && !par['tsdb_stats'] && !par['apif_stats']) {
    lignes.push('\n--- INFORMATIONS MATCH ---');
    const ev = par['tsdb_event'];
    if (ev.strVenue) lignes.push(`Stade     : ${ev.strVenue}`);
    if (ev.intRound) lignes.push(`Journée   : ${ev.intRound}`);
  }

  // ── Cotes MASAP (marches_bookmakers — source principale) ─────────────────────
  // Injectées dans buildContext depuis la requête principale (voir handler)
  if (par['__masap_odds__']) {
    lignes.push('');
    lignes.push(par['__masap_odds__']);
  }

  // ── Cotes legacy SofaScore (conservé en fallback si présent) ─────────────────
  if (!par['__masap_odds__'] && par['odds']?.markets?.length) {
    lignes.push('\n--- COTES (legacy) ---');
    try {
      (par['odds'].markets as any[]).slice(0, 3).forEach((mkt: any) => {
        const choices = (mkt.choices ?? [])
          .map((ch: any) => `${ch.name}: ${ch.fractionalValue ?? '?'}`)
          .join(' | ');
        lignes.push(`${mkt.marketName}: ${choices}`);
      });
    } catch { /* ignoré */ }
  }

  return lignes.join('\n');
}

// ─── Appel Groq : 1 requête → 4 pronostics ───────────────────────────────────

async function groqAnalyse(context: string): Promise<{ pronostics: any[]; tokens: number }> {
  const prompt = `${context}

Analyse ce match et génère exactement 4 pronostics au format JSON suivant (sans markdown) :
{
  "pronostics": [
    { "type": "1X2",            "valeur": "1|N|2",      "fiabilite": 75, "cote_conseille": 1.85, "analyse": "..." },
    { "type": "BTTS",           "valeur": "Oui|Non",    "fiabilite": 70, "cote_conseille": 1.75, "analyse": "..." },
    { "type": "Over/Under 2.5", "valeur": "Plus|Moins", "fiabilite": 65, "cote_conseille": 1.90, "analyse": "..." },
    { "type": "Double Chance",  "valeur": "1N|12|N2",   "fiabilite": 80, "cote_conseille": 1.40, "analyse": "..." }
  ]
}`;

  const res = await fetch(`${GROQ.BASE_URL}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           GROQ.MODEL,
      messages:        [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      max_tokens:      1200,
      temperature:     0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }

  const data    = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '{"pronostics":[]}';
  const tokens  = data.usage?.total_tokens ?? 0;

  try {
    const parsed = JSON.parse(content);
    return { pronostics: parsed.pronostics ?? [], tokens };
  } catch (e) {
    console.error('[groq-parse-fail]', String(e), '| content:', content.slice(0, 500));
    return { pronostics: [], tokens };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // CRON_SECRET toujours requis — refus explicite même si la variable est absente
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now   = new Date().toISOString();
  const in48h = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // Récupérer les matchs à venir
  const { data: matchs, error: matchErr } = await supabase
    .from('matchs_index')
    .select('match_id, home_team, away_team, competition, match_date')
    .gte('match_date', now)
    .lte('match_date', in48h)
    .in('status', ['scheduled', 'inprogress', 'notstarted'])
    .order('match_date')
    .limit(MAX_MATCHS);

  if (matchErr) {
    return new Response(JSON.stringify({ error: matchErr.message }), { status: 500 });
  }

  let totalPronostics = 0;
  let quotaEpuise     = false;

  for (const match of (matchs ?? [])) {
    if (quotaEpuise) break;

    // Cache : pronostics déjà valides dans la table de consultation finale ?
    // On s'appuie sur pronostics_finaux (autorité unique lue par le bot), pas sur
    // l'ancien cache pronostics_pre_calcules, pour éviter que le bot se retrouve
    // sans données alors que l'ancien cache est plein.
    const { data: caches } = await supabase
      .from('pronostics_finaux')
      .select('pronostic_type')
      .eq('match_id', match.match_id)
      .gte('expires_at', now);

    const enCache = new Set((caches ?? []).map((c: any) => c.pronostic_type));
    if (TYPES.every(t => enCache.has(t))) {
      console.log(`[cache] ${match.home_team} vs ${match.away_team} — en cache`);
      continue;
    }

    // Lire tous les marchés bruts disponibles pour ce match (stats, lineups, H2H)
    const { data: marches } = await supabase
      .from('marches_bruts')
      .select('marche_slug, donnees')
      .eq('match_id', match.match_id);

    // Charger les cotes MASAP depuis marches_bookmakers (source principale)
    const { data: oddsRow } = await supabase
      .from('marches_bookmakers')
      .select('marche_donnees, nom_bookmaker')
      .eq('match_id', match.match_id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    // Score de confiance calculé par analyse_confrontation (moteur de calcul).
    // Reporté tel quel sur chaque pronostic final pour ce match.
    const { data: confrontation } = await supabase
      .from('analyse_confrontation')
      .select('confiance_score')
      .eq('match_id', match.match_id)
      .maybeSingle();
    const confianceScore = confrontation?.confiance_score ?? null;

    // Injecter les cotes dans le contexte comme slug virtuel '__masap_odds__'
    const marchesAvecOdds = marches ?? [];
    if (oddsRow?.marche_donnees) {
      try {
        const resumeOdds = resumeOddsGroq(oddsRow.marche_donnees);
        marchesAvecOdds.push({ marche_slug: '__masap_odds__', donnees: resumeOdds } as any);
      } catch { /* ignoré */ }
    }

    if (!marchesAvecOdds.length) {
      console.warn(`[skip] Aucune donnée pour ${match.match_id}`);
      continue;
    }

    // Consommer quota Groq
    if (!await consommerQuota(supabase, 'groq')) { quotaEpuise = true; break; }

    try {
      const context = buildContext(match, marchesAvecOdds);
      const { pronostics, tokens } = await groqAnalyse(context);
      const expiresAt = new Date(Date.now() + GROQ.CACHE_H * 3600 * 1000).toISOString();

      for (const p of pronostics) {
        if (!p.type || enCache.has(p.type)) continue;

        const { error } = await supabase.from('pronostics_pre_calcules').upsert({
          match_id:         match.match_id,
          competition:      match.competition,
          home_team:        match.home_team,
          away_team:        match.away_team,
          match_date:       match.match_date,
          pronostic_type:   p.type,
          pronostic_valeur: p.valeur  ?? 'N/A',
          fiabilite:        Math.min(100, Math.max(0, p.fiabilite ?? 50)),
          cote_conseille:   p.cote_conseille ?? 1.0,
          analyse_texte:    p.analyse ?? '',
          tokens_utilises:  tokens,
          expires_at:       expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });

        if (!error) totalPronostics++;

        // ── Table de consultation finale ──────────────────────────────────
        // Seule table lue par telegram-webhook. Aucun calcul en direct côté bot :
        // ce résumé "prêt à servir" est écrit une fois ici, par batch.
        const { error: errFinal } = await supabase.from('pronostics_finaux').upsert({
          match_id:         match.match_id,
          competition:      match.competition,
          home_team:        match.home_team,
          away_team:        match.away_team,
          match_date:       match.match_date,
          pronostic_type:   p.type,
          pronostic_valeur: p.valeur  ?? 'N/A',
          fiabilite:        Math.min(100, Math.max(0, p.fiabilite ?? 50)),
          confiance_score:  confianceScore,
          cote_conseille:   p.cote_conseille ?? 1.0,
          analyse_texte:    p.analyse ?? '',
          expires_at:       expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });

        if (errFinal) console.warn('[pronostics_finaux]', match.match_id, p.type, errFinal.message);
      }

      console.log(`✅ ${match.home_team} vs ${match.away_team}: ${pronostics.length} pronostics`);
    } catch (e) {
      console.error(`[groq] ${match.home_team} vs ${match.away_team}:`, e);
    }
  }

  const quotas = await lireQuotas(supabase);

  return new Response(JSON.stringify({
    success:          true,
    matchs_traites:   (matchs ?? []).length,
    pronostics_crees: totalPronostics,
    quota_epuise:     quotaEpuise,
    quotas,
    timestamp:        now,
  }), { headers: { 'Content-Type': 'application/json' } });
});
