/**
 * facebook-post — Publication automatique des pronostics sur les Pages Facebook
 *
 * Déclenché par cron chaque matin à 08:00 UTC via Supabase pg_cron.
 *
 * Garanties :
 *   - Idempotence stricte : UNIQUE (connection_id, match_id, post_date)
 *   - Isolation par item : une erreur sur un post ne bloque pas les suivants
 *   - Zéro doublon : vérification avant post + contrainte DB
 *   - RLS service_role : les tokens de page ne sont jamais exposés publiquement
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { posterSurPage, formaterPronosticFacebook } from '../_shared/facebook.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET')               ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

Deno.serve(async (req: Request) => {
  // Sécurité : vérifier le secret cron
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const rapport = {
    postsPublies: 0,
    erreurs:      0,
    sautes:       0,
    connexions:   0,
    details:      [] as string[],
  };

  // 1. Récupérer toutes les connexions Facebook actives
  const { data: connexions, error: errConn } = await supabase
    .from('facebook_connections')
    .select('id, fb_page_id, fb_page_name, fb_page_access_token')
    .eq('is_active', true);

  if (errConn) {
    console.error('[facebook-post] Erreur chargement connexions:', errConn.message);
    return new Response(
      JSON.stringify({ error: 'DB error loading connections', details: errConn.message }),
      { status: 500 }
    );
  }

  if (!connexions?.length) {
    return new Response(
      JSON.stringify({ message: 'Aucune connexion active', rapport }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  rapport.connexions = connexions.length;

  // 2. Pronostics du jour avec fiabilité ≥ 70
  const now     = new Date();
  const finJour = new Date(now);
  finJour.setHours(23, 59, 59, 999);
  const today   = now.toISOString().slice(0, 10); // YYYY-MM-DD pour la clé d'idempotence

  const { data: pronos, error: errPronos } = await supabase
    .from('pronostics_finaux')
    .select(
      'match_id, competition, home_team, away_team, match_date, ' +
      'pronostic_type, pronostic_valeur, cote_conseille, fiabilite, analyse_texte'
    )
    .gte('match_date', now.toISOString())
    .lte('match_date', finJour.toISOString())
    .gte('fiabilite', 70)
    .gte('expires_at', now.toISOString())
    .order('fiabilite', { ascending: false })
    .limit(30);

  if (errPronos) {
    console.error('[facebook-post] Erreur chargement pronostics:', errPronos.message);
    return new Response(
      JSON.stringify({ error: 'DB error loading pronostics', details: errPronos.message }),
      { status: 500 }
    );
  }

  if (!pronos?.length) {
    return new Response(
      JSON.stringify({ message: 'Aucun pronostic du jour (fiabilité ≥ 70)', rapport }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3. Grouper par match_id — max 3 pronostics par match
  const parMatch = new Map<string, typeof pronos>();
  for (const p of pronos) {
    if (!parMatch.has(p.match_id)) parMatch.set(p.match_id, []);
    const l = parMatch.get(p.match_id)!;
    if (l.length < 3) l.push(p);
  }

  // 4. Publier sur chaque connexion — ISOLATION PAR ITEM (try/catch individuel)
  for (const connexion of connexions) {
    for (const [matchId, matchPronos] of parMatch) {
      try {
        // Idempotence : vérifier si déjà publié aujourd'hui pour ce match
        const { data: dejaPublie, error: errCheck } = await supabase
          .from('facebook_posts_log')
          .select('id')
          .eq('connection_id', connexion.id)
          .eq('match_id', matchId)
          .eq('post_date', today)
          .eq('status', 'success')
          .maybeSingle();

        if (errCheck) {
          console.warn(`[facebook-post] Erreur vérif doublon ${matchId}:`, errCheck.message);
        }

        if (dejaPublie) {
          rapport.sautes++;
          continue;
        }

        // Publier sur la Page Facebook
        const message = formaterPronosticFacebook(matchPronos as any);
        const result  = await posterSurPage(
          connexion.fb_page_access_token,
          connexion.fb_page_id,
          message
        );

        // Tracer le résultat avec la clé d'idempotence par jour
        const { error: errLog } = await supabase.from('facebook_posts_log').upsert({
          connection_id:  connexion.id,
          match_id:       matchId,
          post_date:      today,
          pronostic_type: matchPronos.map((p) => p.pronostic_type).join(','),
          fb_post_id:     result.postId ?? null,
          status:         result.success ? 'success' : 'error',
          error_message:  result.error ?? null,
        }, { onConflict: 'connection_id,match_id,post_date' });

        if (errLog) {
          console.warn(`[facebook-post] Erreur log ${matchId}:`, errLog.message);
        }

        if (result.success) {
          rapport.postsPublies++;

          // Mettre à jour last_post_at (best-effort, non bloquant)
          supabase
            .from('facebook_connections')
            .update({ last_post_at: new Date().toISOString() })
            .eq('id', connexion.id)
            .then(({ error: e }) => {
              if (e) console.warn('[facebook-post] Erreur update last_post_at:', e.message);
            });

        } else {
          rapport.erreurs++;
          const detail = `Page "${connexion.fb_page_name}" / match ${matchId}: ${result.error}`;
          rapport.details.push(detail);
          console.error(`[facebook-post] ${detail}`);
        }

      } catch (itemErr) {
        // Isolation : une erreur sur un item ne bloque pas les suivants
        rapport.erreurs++;
        const detail = `Exception page "${connexion.fb_page_name}" / match ${matchId}: ${String(itemErr)}`;
        rapport.details.push(detail);
        console.error(`[facebook-post] ${detail}`);
      }
    }
  }

  return new Response(
    JSON.stringify({ success: true, rapport }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
