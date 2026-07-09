import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getH2HEvents } from '../_shared/sofascore.ts';
import { analyserMatch } from '../_shared/groq.ts';
import { CONFIG } from '../_shared/config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Types de pronostics à générer par défaut
const PRONOSTIC_TYPES = ['1X2', 'BTTS', 'Plus/Moins 2.5'];

async function analyserUnMatch(match: any): Promise<number> {
  const { match_id, home_team, away_team, competition, match_date, home_form, away_form } = match;
  let analysesCreees = 0;

  // Récupérer H2H depuis SofaScore
  let h2hData: any[] = [];
  try {
    const customId = `${home_team.toLowerCase().replace(/\s+/g, '-')}-${away_team.toLowerCase().replace(/\s+/g, '-')}`;
    const h2h = await getH2HEvents(customId);
    h2hData = h2h?.events ?? [];

    // Stocker le H2H dans matchs_historique
    await supabase
      .from('matchs_historique')
      .update({ h2h: h2hData })
      .eq('match_id', match_id);
  } catch {
    // H2H non disponible, on continue sans
  }

  for (const pronosticType of PRONOSTIC_TYPES) {
    // Vérifier si le pronostic existe déjà (cache)
    const { data: existingProno } = await supabase
      .from('pronostics_pre_calcules')
      .select('id')
      .eq('match_id', match_id)
      .eq('pronostic_type', pronosticType)
      .gte('expires_at', new Date().toISOString())
      .single();

    if (existingProno) continue; // Cache valide → on skip Groq

    try {
      const result = await analyserMatch(
        home_team,
        away_team,
        competition,
        match_date,
        home_form ?? [],
        away_form ?? [],
        h2hData,
        pronosticType
      );

      const expiresAt = new Date(Date.now() + CONFIG.CACHE_HOURS * 3600 * 1000).toISOString();

      await supabase.from('pronostics_pre_calcules').upsert({
        match_id,
        competition,
        home_team,
        away_team,
        match_date,
        pronostic_type: result.pronostic_type,
        pronostic_valeur: result.pronostic_valeur,
        fiabilite: result.fiabilite,
        cote_conseille: result.cote_conseille,
        analyse_texte: result.analyse_texte,
        tokens_utilises: result.tokens_utilises,
        expires_at: expiresAt,
      }, { onConflict: 'match_id,pronostic_type' });

      analysesCreees++;
    } catch (e) {
      console.error(`Erreur Groq pour ${home_team} vs ${away_team} (${pronosticType}):`, e);
    }
  }

  return analysesCreees;
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Récupérer les matchs à analyser (prochaines 48h, sans pronostics récents)
  const in48h = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const { data: matchs, error } = await supabase
    .from('matchs_historique')
    .select('*')
    .eq('status', 'scheduled')
    .gte('match_date', new Date().toISOString())
    .lte('match_date', in48h)
    .limit(10);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!matchs?.length) {
    return new Response(JSON.stringify({ success: true, message: 'Aucun match à analyser', total: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let totalAnalyses = 0;
  for (const match of matchs) {
    totalAnalyses += await analyserUnMatch(match);
  }

  return new Response(JSON.stringify({
    success: true,
    matchs_analyses: matchs.length,
    pronostics_crees: totalAnalyses,
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
