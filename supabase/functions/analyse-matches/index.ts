/**
 * analyse-matches — Moteur d'analyse avec protection de quota Groq
 *
 * Optimisation quota :
 * - 1 seul appel Groq par match (génère les 4 types de pronostics en une fois)
 *   au lieu de 4 appels séparés → division par 4 de la consommation
 * - Cache 24h sur les pronostics (au lieu de 6h)
 * - Max 5 matchs analysés par exécution
 * - Stoppe si quota Groq épuisé
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG, SYSTEM_PROMPT } from '../_shared/config.ts';
import { consommerQuota, lireQuotas } from '../_shared/quota.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY     = Deno.env.get('GROQ_API_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const CACHE_HEURES  = 24;  // Pronostics valides 24h (économie max)
const MAX_MATCHS    = 5;   // Max 5 matchs analysés par run

// ─── Construire le contexte compact pour Groq ───────────────────────────────
function buildContextGroq(match: any, marches: any[]): string {
  const lines: string[] = [
    `Match: ${match.home_team} vs ${match.away_team}`,
    `Compétition: ${match.competition}`,
    `Date: ${new Date(match.match_date).toLocaleDateString('fr-FR')}`,
    '',
    '=== DONNÉES DISPONIBLES ===',
  ];

  for (const m of marches) {
    lines.push(`\n--- ${m.marche_slug.toUpperCase()} ---`);
    switch (m.marche_slug) {
      case 'statistiques': {
        const flat = (m.donnees?.statistics ?? [])
          .flatMap((g: any) => g.groups ?? [])
          .flatMap((gr: any) => gr.statisticsItems ?? [])
          .slice(0, 12)
          .map((s: any) => `${s.name}: ${s.home} - ${s.away}`);
        lines.push(...flat);
        break;
      }
      case 'h2h': {
        (m.donnees?.events ?? []).slice(0, 5).forEach((e: any) => {
          const yr = new Date((e.startTimestamp ?? 0) * 1000).getFullYear();
          lines.push(`${e.homeTeam?.name} ${e.homeScore?.current}-${e.awayScore?.current} ${e.awayTeam?.name} (${yr})`);
        });
        break;
      }
      case 'incidents': {
        (m.donnees?.incidents ?? []).slice(0, 8).forEach((inc: any) => {
          lines.push(`${inc.time?.played ?? '?'}' ${inc.incidentType}: ${inc.player?.name ?? ''}`);
        });
        break;
      }
      case 'lineups': {
        lines.push(`Formation dom: ${m.donnees?.home?.formation ?? 'N/D'}`);
        lines.push(`Formation ext: ${m.donnees?.away?.formation ?? 'N/D'}`);
        break;
      }
      case 'meilleurs_joueurs': {
        const players = m.donnees?.bestHomeTeamPlayer && m.donnees?.bestAwayTeamPlayer
          ? [m.donnees.bestHomeTeamPlayer, m.donnees.bestAwayTeamPlayer]
          : (m.donnees?.players ?? []);
        players.slice(0, 4).forEach((p: any) =>
          lines.push(`${p.player?.name ?? p.name}: note ${p.value ?? 'N/D'}`),
        );
        break;
      }
      case 'stats_domicile':
      case 'stats_exterieur': {
        const label = m.marche_slug === 'stats_domicile' ? match.home_team : match.away_team;
        const s = m.donnees?.statistics ?? m.donnees;
        if (s) {
          lines.push(`${label} — V:${s.wins ?? '?'} N:${s.draws ?? '?'} D:${s.losses ?? '?'} | Buts+:${s.goalsScored ?? '?'} Buts-:${s.goalsConceded ?? '?'}`);
        }
        break;
      }
      case 'odds': {
        (m.donnees?.markets ?? []).slice(0, 3).forEach((mkt: any) => {
          const choices = (mkt.choices ?? []).map((c: any) => `${c.name}:${c.fractionalValue ?? c.initialFractionalValue}`).join(' | ');
          lines.push(`${mkt.marketName}: ${choices}`);
        });
        break;
      }
      default:
        lines.push(JSON.stringify(m.donnees).slice(0, 150));
    }
  }

  return lines.join('\n');
}

// ─── 1 seul appel Groq → 4 pronostics ──────────────────────────────────────
// Économie : 1 appel au lieu de 4, même cache Groq
async function groqTousPronostics(context: string): Promise<{
  pronostics: Array<{ type: string; valeur: string; fiabilite: number; cote: number; analyse: string }>;
  tokens: number;
}> {
  const userPrompt = `${context}

---
Génère 4 pronostics en un seul JSON pour ce match. Réponds UNIQUEMENT avec ce JSON (sans markdown) :
{
  "pronostics": [
    {"type":"1X2",            "valeur":"...", "fiabilite":75, "cote_conseille":1.85, "analyse":"2-3 phrases"},
    {"type":"BTTS",           "valeur":"...", "fiabilite":65, "cote_conseille":1.70, "analyse":"2-3 phrases"},
    {"type":"Plus/Moins 2.5", "valeur":"...", "fiabilite":70, "cote_conseille":1.90, "analyse":"2-3 phrases"},
    {"type":"Score Exact",    "valeur":"...", "fiabilite":30, "cote_conseille":6.00, "analyse":"2-3 phrases"}
  ]
}`;

  const res = await fetch(`${CONFIG.GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           CONFIG.GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens:      CONFIG.MAX_TOKENS_GROQ,
      temperature:     0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data   = await res.json();
  const parsed = JSON.parse(data.choices[0]?.message?.content ?? '{}');

  return {
    pronostics: (parsed.pronostics ?? []).map((p: any) => ({
      type:      p.type     ?? 'Inconnu',
      valeur:    p.valeur   ?? 'N/A',
      fiabilite: Math.min(100, Math.max(0, p.fiabilite ?? 50)),
      cote:      p.cote_conseille ?? 1.0,
      analyse:   p.analyse  ?? '',
    })),
    tokens: data.usage?.total_tokens ?? 0,
  };
}

// ─── Handler principal ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const quotaAvant    = await lireQuotas(supabase);
  const in48h         = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  let totalPronostics = 0;
  let quotaEpuise     = false;

  // Matchs à venir dans les 48h
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('*')
    .eq('status', 'scheduled')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in48h)
    .limit(MAX_MATCHS);

  if (!matchs?.length) {
    return new Response(JSON.stringify({ success: true, message: 'Aucun match à analyser', total: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  for (const match of matchs) {
    // Vérifier si ce match a déjà tous ses pronostics en cache valide
    const { data: caches } = await supabase
      .from('pronostics_pre_calcules')
      .select('pronostic_type')
      .eq('match_id', match.match_id)
      .gte('expires_at', new Date().toISOString());

    const typesEnCache = new Set((caches ?? []).map((c: any) => c.pronostic_type));
    const typesVoulus  = ['1X2', 'BTTS', 'Plus/Moins 2.5', 'Score Exact'];
    const toutEnCache  = typesVoulus.every(t => typesEnCache.has(t));

    if (toutEnCache) continue; // Aucun appel Groq nécessaire

    // Charger les données brutes
    const { data: marches } = await supabase
      .from('marches_bruts')
      .select('marche_slug, donnees')
      .eq('match_id', match.match_id);

    if (!marches?.length) continue;

    // Vérifier et consommer 1 seule unité de quota Groq pour les 4 pronostics
    const autorise = await consommerQuota(supabase, 'groq');
    if (!autorise) { quotaEpuise = true; break; }

    try {
      const context      = buildContextGroq(match, marches);
      const { pronostics, tokens } = await groqTousPronostics(context);
      const expiresAt    = new Date(Date.now() + CACHE_HEURES * 3600 * 1000).toISOString();

      for (const p of pronostics) {
        if (typesEnCache.has(p.type)) continue; // Ne pas écraser un cache valide
        await supabase.from('pronostics_pre_calcules').upsert({
          match_id:         match.match_id,
          competition:      match.competition,
          home_team:        match.home_team,
          away_team:        match.away_team,
          match_date:       match.match_date,
          pronostic_type:   p.type,
          pronostic_valeur: p.valeur,
          fiabilite:        p.fiabilite,
          cote_conseille:   p.cote,
          analyse_texte:    p.analyse,
          tokens_utilises:  tokens,
          expires_at:       expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });
        totalPronostics++;
      }
    } catch (e) {
      console.error(`Groq erreur [${match.home_team} vs ${match.away_team}]:`, e);
    }
  }

  const quotaApres = await lireQuotas(supabase);

  return new Response(JSON.stringify({
    success:           true,
    matchs_analyses:   matchs.length,
    pronostics_crees:  totalPronostics,
    quota_epuise:      quotaEpuise,
    quota_groq:        quotaApres.groq ?? null,
    quota_consomme:    { groq: (quotaApres.groq?.compteur ?? 0) - (quotaAvant.groq?.compteur ?? 0) },
    timestamp:         new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
