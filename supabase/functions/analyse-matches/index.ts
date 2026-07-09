/**
 * analyse-matches — Auto-suffisant (tout inliné, pas d'imports relatifs)
 * 1 appel Groq par match → 4 pronostics. Cache 24h. Protégé par quota.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY     = Deno.env.get('GROQ_API_KEY') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROQ_BASE   = 'https://api.groq.com/openai/v1';
const GROQ_MODEL  = 'llama3-70b-8192';
const CACHE_H     = 24;
const MAX_MATCHS  = 5;

const SYSTEM_PROMPT = `Tu es un expert analyste sportif. Analyse les données et génère des pronostics précis en JSON strict. Règles : utilise uniquement les données fournies, donne un indice de fiabilité entre 0 et 100, sois concis (2-3 phrases max par analyse).`;

// ─── Quota ────────────────────────────────────────────────────────────────────
async function consommerQuota(api: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) { console.warn('[quota]', error.message); return true; }
  if (!data) console.warn(`[quota] 🛑 ${api} épuisé`);
  return Boolean(data);
}

// ─── Contexte Groq ────────────────────────────────────────────────────────────
function buildContext(match: any, marches: any[]): string {
  const lines = [
    `Match: ${match.home_team} vs ${match.away_team}`,
    `Compétition: ${match.competition}`,
    `Date: ${new Date(match.match_date).toLocaleDateString('fr-FR')}`,
    '', '=== DONNÉES ===',
  ];

  for (const m of marches) {
    lines.push(`\n--- ${m.marche_slug.toUpperCase()} ---`);
    try {
      switch (m.marche_slug) {
        case 'statistiques':
          (m.donnees?.statistics ?? [])
            .flatMap((g: any) => g.groups ?? [])
            .flatMap((gr: any) => gr.statisticsItems ?? [])
            .slice(0, 10)
            .forEach((s: any) => lines.push(`${s.name}: ${s.home} - ${s.away}`));
          break;
        case 'h2h':
          (m.donnees?.events ?? []).slice(0, 5).forEach((e: any) => {
            const yr = new Date((e.startTimestamp ?? 0) * 1000).getFullYear();
            lines.push(`${e.homeTeam?.name} ${e.homeScore?.current}-${e.awayScore?.current} ${e.awayTeam?.name} (${yr})`);
          });
          break;
        case 'incidents':
          (m.donnees?.incidents ?? []).slice(0, 8).forEach((inc: any) =>
            lines.push(`${inc.time?.played ?? '?'}' ${inc.incidentType}: ${inc.player?.name ?? ''}`));
          break;
        case 'lineups':
          lines.push(`Dom: ${m.donnees?.home?.formation ?? 'N/D'} | Ext: ${m.donnees?.away?.formation ?? 'N/D'}`);
          break;
        case 'stats_domicile':
        case 'stats_exterieur': {
          const lbl = m.marche_slug === 'stats_domicile' ? match.home_team : match.away_team;
          const s = m.donnees?.statistics ?? m.donnees;
          if (s) lines.push(`${lbl}: V${s.wins ?? '?'} N${s.draws ?? '?'} D${s.losses ?? '?'} | +${s.goalsScored ?? '?'} -${s.goalsConceded ?? '?'}`);
          break;
        }
        case 'odds':
          (m.donnees?.markets ?? []).slice(0, 3).forEach((mkt: any) => {
            const c = (mkt.choices ?? []).map((ch: any) => `${ch.name}:${ch.fractionalValue ?? '?'}`).join(' | ');
            lines.push(`${mkt.marketName}: ${c}`);
          });
          break;
        default:
          lines.push(JSON.stringify(m.donnees).slice(0, 120));
      }
    } catch { /* marché ignoré si erreur de parsing */ }
  }
  return lines.join('\n');
}

// ─── Groq : 1 appel → 4 pronostics ───────────────────────────────────────────
async function groqAnalyse(context: string) {
  const prompt = `${context}\n\n---\nGénère exactement 4 pronostics en JSON strict (sans markdown) :\n{"pronostics":[{"type":"1X2","valeur":"...","fiabilite":75,"cote_conseille":1.85,"analyse":"..."},{"type":"BTTS","valeur":"...","fiabilite":65,"cote_conseille":1.70,"analyse":"..."},{"type":"Plus/Moins 2.5","valeur":"...","fiabilite":70,"cote_conseille":1.90,"analyse":"..."},{"type":"Score Exact","valeur":"...","fiabilite":30,"cote_conseille":6.00,"analyse":"..."}]}`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      max_tokens: 900,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data   = await res.json();
  const parsed = JSON.parse(data.choices[0]?.message?.content ?? '{}');
  return { pronostics: parsed.pronostics ?? [], tokens: data.usage?.total_tokens ?? 0 };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const in48h = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const { data: matchs } = await supabase
    .from('matchs_index')
    .select('*')
    .eq('status', 'scheduled')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in48h)
    .limit(MAX_MATCHS);

  if (!matchs?.length) {
    return new Response(JSON.stringify({ success: true, message: 'Aucun match à analyser', total: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  let totalPronostics = 0;
  let quotaEpuise = false;
  const TYPES = ['1X2', 'BTTS', 'Plus/Moins 2.5', 'Score Exact'];

  for (const match of matchs) {
    const { data: caches } = await supabase
      .from('pronostics_pre_calcules')
      .select('pronostic_type')
      .eq('match_id', match.match_id)
      .gte('expires_at', new Date().toISOString());

    const enCache = new Set((caches ?? []).map((c: any) => c.pronostic_type));
    if (TYPES.every(t => enCache.has(t))) continue;

    const { data: marches } = await supabase.from('marches_bruts').select('marche_slug, donnees').eq('match_id', match.match_id);
    if (!marches?.length) continue;

    if (!await consommerQuota('groq')) { quotaEpuise = true; break; }

    try {
      const context = buildContext(match, marches);
      const { pronostics, tokens } = await groqAnalyse(context);
      const expiresAt = new Date(Date.now() + CACHE_H * 3600 * 1000).toISOString();

      for (const p of pronostics) {
        if (enCache.has(p.type)) continue;
        await supabase.from('pronostics_pre_calcules').upsert({
          match_id:         match.match_id,
          competition:      match.competition,
          home_team:        match.home_team,
          away_team:        match.away_team,
          match_date:       match.match_date,
          pronostic_type:   p.type,
          pronostic_valeur: p.valeur,
          fiabilite:        Math.min(100, Math.max(0, p.fiabilite ?? 50)),
          cote_conseille:   p.cote_conseille ?? 1.0,
          analyse_texte:    p.analyse ?? '',
          tokens_utilises:  tokens,
          expires_at:       expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });
        totalPronostics++;
      }
    } catch (e) { console.error(`Groq [${match.home_team} vs ${match.away_team}]:`, e); }
  }

  const { data: quotas } = await supabase.from('quota_journalier').select('api,compteur,limite').eq('date', new Date().toISOString().slice(0, 10));

  return new Response(JSON.stringify({
    success: true,
    matchs_analyses:  matchs.length,
    pronostics_crees: totalPronostics,
    quota_epuise:     quotaEpuise,
    quotas: Object.fromEntries((quotas ?? []).map((q: any) => [q.api, { compteur: q.compteur, limite: q.limite, reste: q.limite - q.compteur }])),
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
});
