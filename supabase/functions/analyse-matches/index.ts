/**
 * analyse-matches — Moteur d'analyse dynamique
 *
 * Lit TOUTES les données disponibles dans marches_bruts pour un match,
 * les envoie à Groq qui décide quoi utiliser selon le type de pronostic.
 * Ne génère jamais un pronostic déjà en cache valide.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG, SYSTEM_PROMPT } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY     = Deno.env.get('GROQ_API_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

// Types de pronostics à générer automatiquement
const PRONOSTIC_TYPES = ['1X2', 'BTTS', 'Plus/Moins 2.5', 'Score Exact'];

// ─── Construire le résumé compact des données brutes pour Groq ─────────────
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
        const stats = m.donnees?.statistics ?? [];
        const flat = stats.flatMap((g: any) => g.groups ?? [])
          .flatMap((gr: any) => gr.statisticsItems ?? [])
          .slice(0, 15)
          .map((s: any) => `${s.name}: ${s.home} - ${s.away}`);
        lines.push(...flat);
        break;
      }
      case 'h2h': {
        const events = m.donnees?.events ?? [];
        events.slice(0, 5).forEach((e: any) => {
          lines.push(`${e.homeTeam?.name} ${e.homeScore?.current}-${e.awayScore?.current} ${e.awayTeam?.name} (${new Date((e.startTimestamp??0)*1000).getFullYear()})`);
        });
        break;
      }
      case 'incidents': {
        const incidents = m.donnees?.incidents ?? [];
        incidents.slice(0, 10).forEach((inc: any) => {
          lines.push(`${inc.time?.played ?? '?'}' ${inc.incidentType}: ${inc.player?.name ?? ''} (${inc.isHome ? match.home_team : match.away_team})`);
        });
        break;
      }
      case 'lineups': {
        const home = m.donnees?.home?.players ?? [];
        const away = m.donnees?.away?.players ?? [];
        lines.push(`Formation dom: ${m.donnees?.home?.formation ?? 'N/D'} (${home.length} joueurs)`);
        lines.push(`Formation ext: ${m.donnees?.away?.formation ?? 'N/D'} (${away.length} joueurs)`);
        break;
      }
      case 'meilleurs_joueurs': {
        const players = m.donnees?.bestHomeTeamPlayer && m.donnees?.bestAwayTeamPlayer
          ? [m.donnees.bestHomeTeamPlayer, m.donnees.bestAwayTeamPlayer]
          : m.donnees?.players ?? [];
        players.slice(0, 4).forEach((p: any) => {
          lines.push(`${p.player?.name ?? p.name}: note ${p.value ?? 'N/D'}`);
        });
        break;
      }
      case 'stats_domicile':
      case 'stats_exterieur': {
        const label = m.marche_slug === 'stats_domicile' ? match.home_team : match.away_team;
        const s = m.donnees?.statistics ?? m.donnees;
        if (s) {
          lines.push(`${label} — buts marqués: ${s.goalsScored ?? 'N/D'}, concédés: ${s.goalsConceded ?? 'N/D'}`);
          lines.push(`Victoires: ${s.wins ?? 'N/D'}, Nuls: ${s.draws ?? 'N/D'}, Défaites: ${s.losses ?? 'N/D'}`);
        }
        break;
      }
      case 'odds': {
        const markets = m.donnees?.markets ?? [];
        markets.slice(0, 3).forEach((mkt: any) => {
          const choices = (mkt.choices ?? []).map((c: any) => `${c.name}:${c.fractionalValue ?? c.initialFractionalValue}`).join(' | ');
          lines.push(`${mkt.marketName}: ${choices}`);
        });
        break;
      }
      default:
        lines.push(JSON.stringify(m.donnees).slice(0, 200));
    }
  }

  return lines.join('\n');
}

// ─── Appel Groq ────────────────────────────────────────────────────────────
async function groqPronostic(context: string, pronosticType: string): Promise<{
  valeur: string; fiabilite: number; cote: number; analyse: string; tokens: number;
}> {
  const userPrompt = `${context}

---
Génère un pronostic de type "${pronosticType}" en te basant UNIQUEMENT sur les données ci-dessus.
Réponds en JSON strict (sans markdown) :
{"pronostic_valeur":"...","fiabilite":75,"cote_conseille":1.85,"analyse":"3-4 phrases max"}`;

  const res = await fetch(`${CONFIG.GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: CONFIG.MAX_TOKENS_GROQ,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0]?.message?.content ?? '{}');
  return {
    valeur:   parsed.pronostic_valeur ?? 'N/A',
    fiabilite: Math.min(100, Math.max(0, parsed.fiabilite ?? 50)),
    cote:      parsed.cote_conseille ?? 1.0,
    analyse:   parsed.analyse ?? '',
    tokens:    data.usage?.total_tokens ?? 0,
  };
}

// ─── Handler principal ───────────────────────────────────────────────────────
Deno.serve(async (_req) => {
  const in48h = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // Matchs à venir dans les 48h avec au moins un marché disponible
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('*')
    .eq('status', 'scheduled')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in48h)
    .limit(10);

  if (!matchs?.length) {
    return new Response(JSON.stringify({ success: true, message: 'Aucun match à analyser', total: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let totalPronostics = 0;

  for (const match of matchs) {
    // Charger TOUS les marchés bruts disponibles pour ce match
    const { data: marches } = await supabase
      .from('marches_bruts')
      .select('marche_slug, donnees')
      .eq('match_id', match.match_id);

    if (!marches?.length) continue; // Pas encore de données → skip

    const context = buildContextGroq(match, marches);

    for (const type of PRONOSTIC_TYPES) {
      // Vérifier le cache (pronostic valide existant)
      const { data: cached } = await supabase
        .from('pronostics_pre_calcules')
        .select('id')
        .eq('match_id', match.match_id)
        .eq('pronostic_type', type)
        .gte('expires_at', new Date().toISOString())
        .single();

      if (cached) continue; // Cache valide → on ne rappelle pas Groq

      try {
        const result = await groqPronostic(context, type);
        const expiresAt = new Date(Date.now() + CONFIG.CACHE_HOURS * 3600 * 1000).toISOString();

        await supabase.from('pronostics_pre_calcules').upsert({
          match_id:        match.match_id,
          competition:     match.competition,
          home_team:       match.home_team,
          away_team:       match.away_team,
          match_date:      match.match_date,
          pronostic_type:  type,
          pronostic_valeur: result.valeur,
          fiabilite:       result.fiabilite,
          cote_conseille:  result.cote,
          analyse_texte:   result.analyse,
          tokens_utilises: result.tokens,
          expires_at:      expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });

        totalPronostics++;
      } catch (e) {
        console.error(`Groq erreur [${match.home_team} vs ${match.away_team}] [${type}]:`, e);
      }
    }
  }

  return new Response(JSON.stringify({
    success:           true,
    matchs_analyses:   matchs.length,
    pronostics_crees:  totalPronostics,
    timestamp:         new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
