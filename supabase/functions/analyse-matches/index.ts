/**
 * analyse-matches v2 — Cycle complet fetch → Groq → pronostics_pre_calcules
 * Lit matchs_index + marches_bruts, génère 4 pronostics par match via Groq.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GROQ_KEY     = Deno.env.get('GROQ_API_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama3-70b-8192';
const CACHE_H    = 24;        // validité pronostic en heures
const MAX_MATCHS = 10;        // matchs analysés par run
const TYPES      = ['1X2', 'BTTS', 'Over/Under 2.5', 'Double Chance'];

const SYSTEM_PROMPT = `Tu es un expert analyste sportif. Analyse les données et génère des pronostics précis en JSON strict. Règles : utilise uniquement les données fournies, donne un indice de fiabilité entre 0 et 100, sois concis (2-3 phrases max par analyse). Format de réponse JSON strict.`;

// ─── Quota ────────────────────────────────────────────────────────────────────
async function quota(api: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) { console.warn('[quota]', error.message); return true; }
  if (!data)  console.warn(`[quota] 🛑 ${api} épuisé`);
  return Boolean(data);
}

// ─── Construction du contexte pour Groq ──────────────────────────────────────
function buildContext(match: any, marches: any[]): string {
  const lignes = [
    `Match: ${match.home_team} vs ${match.away_team}`,
    `Compétition: ${match.competition}`,
    `Date: ${new Date(match.match_date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`,
    '',
    '=== DONNÉES DISPONIBLES ===',
  ];

  for (const m of marches) {
    lignes.push(`\n--- ${m.marche_slug.toUpperCase()} ---`);
    try {
      switch (m.marche_slug) {
        case 'statistiques':
          (m.donnees?.statistics ?? [])
            .flatMap((g: any) => g.groups ?? [])
            .flatMap((gr: any) => gr.statisticsItems ?? [])
            .slice(0, 12)
            .forEach((s: any) => lignes.push(`${s.name}: ${s.home} / ${s.away}`));
          break;
        case 'h2h':
          (m.donnees?.events ?? []).slice(0, 6).forEach((e: any) => {
            const yr = new Date((e.startTimestamp ?? 0) * 1000).getFullYear();
            lignes.push(`${e.homeTeam?.name} ${e.homeScore?.current ?? '?'}-${e.awayScore?.current ?? '?'} ${e.awayTeam?.name} (${yr})`);
          });
          break;
        case 'lineups':
          lignes.push(`Domicile: ${m.donnees?.home?.formation ?? 'N/D'} | Extérieur: ${m.donnees?.away?.formation ?? 'N/D'}`);
          break;
        case 'incidents':
          (m.donnees?.incidents ?? [])
            .filter((i: any) => ['goal', 'card', 'substitution'].includes(i.incidentType))
            .slice(0, 10)
            .forEach((inc: any) =>
              lignes.push(`${inc.time?.played ?? '?'}' ${inc.incidentType}: ${inc.player?.name ?? ''}`)
            );
          break;
        case 'odds':
          (m.donnees?.markets ?? []).slice(0, 3).forEach((mkt: any) => {
            const choices = (mkt.choices ?? [])
              .map((ch: any) => `${ch.name}: ${ch.fractionalValue ?? '?'}`)
              .join(' | ');
            lignes.push(`${mkt.marketName}: ${choices}`);
          });
          break;
        default:
          lignes.push(JSON.stringify(m.donnees).slice(0, 150));
      }
    } catch { /* marché ignoré si erreur parsing */ }
  }
  return lignes.join('\n');
}

// ─── Appel Groq : 1 requête → 4 pronostics ───────────────────────────────────
async function groqAnalyse(context: string): Promise<{ pronostics: any[]; tokens: number }> {
  const prompt = `${context}

Analyse ce match et génère exactement 4 pronostics au format JSON suivant (sans markdown) :
{
  "pronostics": [
    { "type": "1X2",               "valeur": "1|N|2",           "fiabilite": 75, "cote_conseille": 1.85, "analyse": "..." },
    { "type": "BTTS",              "valeur": "Oui|Non",          "fiabilite": 70, "cote_conseille": 1.75, "analyse": "..." },
    { "type": "Over/Under 2.5",    "valeur": "Plus|Moins",       "fiabilite": 65, "cote_conseille": 1.90, "analyse": "..." },
    { "type": "Double Chance",     "valeur": "1N|12|N2",        "fiabilite": 80, "cote_conseille": 1.40, "analyse": "..." }
  ]
}`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           GROQ_MODEL,
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
  } catch {
    return { pronostics: [], tokens };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now    = new Date().toISOString();
  const in48h  = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // Récupérer les matchs à venir depuis matchs_index
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

    // Vérifier le cache : pronostics déjà valides ?
    const { data: caches } = await supabase
      .from('pronostics_pre_calcules')
      .select('pronostic_type')
      .eq('match_id', match.match_id)
      .gte('expires_at', now);

    const enCache = new Set((caches ?? []).map((c: any) => c.pronostic_type));
    if (TYPES.every(t => enCache.has(t))) {
      console.log(`[cache] ${match.home_team} vs ${match.away_team} déjà en cache`);
      continue;
    }

    // Lire les marchés disponibles
    const { data: marches } = await supabase
      .from('marches_bruts')
      .select('marche_slug, donnees')
      .eq('match_id', match.match_id);

    if (!marches?.length) {
      console.warn(`[skip] Aucun marché pour ${match.match_id}`);
      continue;
    }

    // Consommer quota Groq
    if (!await quota('groq')) { quotaEpuise = true; break; }

    try {
      const context       = buildContext(match, marches);
      const { pronostics, tokens } = await groqAnalyse(context);
      const expiresAt     = new Date(Date.now() + CACHE_H * 3600 * 1000).toISOString();

      for (const p of pronostics) {
        if (!p.type || enCache.has(p.type)) continue;

        const { error } = await supabase.from('pronostics_pre_calcules').upsert({
          match_id:         match.match_id,
          competition:      match.competition,
          home_team:        match.home_team,
          away_team:        match.away_team,
          match_date:       match.match_date,
          pronostic_type:   p.type,
          pronostic_valeur: p.valeur ?? 'N/A',
          fiabilite:        Math.min(100, Math.max(0, p.fiabilite ?? 50)),
          cote_conseille:   p.cote_conseille ?? 1.0,
          analyse_texte:    p.analyse ?? '',
          tokens_utilises:  tokens,
          expires_at:       expiresAt,
        }, { onConflict: 'match_id,pronostic_type' });

        if (!error) totalPronostics++;
      }

      console.log(`✅ ${match.home_team} vs ${match.away_team}: ${pronostics.length} pronostics`);
    } catch (e) {
      console.error(`[groq] ${match.home_team} vs ${match.away_team}:`, e);
    }
  }

  const { data: quotas } = await supabase
    .from('quota_journalier')
    .select('api,compteur,limite')
    .eq('date', now.slice(0, 10));

  return new Response(JSON.stringify({
    success:          true,
    matchs_traites:   (matchs ?? []).length,
    pronostics_crees: totalPronostics,
    quota_epuise:     quotaEpuise,
    quotas: Object.fromEntries((quotas ?? []).map((q: any) => [
      q.api, { compteur: q.compteur, limite: q.limite, reste: q.limite - q.compteur },
    ])),
    timestamp: now,
  }), { headers: { 'Content-Type': 'application/json' } });
});
