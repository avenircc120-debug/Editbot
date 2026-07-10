/**
 * facebook-post — Diffusion automatique des scores en direct sur les Pages Facebook
 *
 * Déclenché à l'événement (appelé directement par fetch-matches dès qu'un score
 * change sur un match en direct) — aucun cron indépendant.
 *
 * Body attendu : { matches: [{ matchId, competition, homeTeam, awayTeam, homeScore, awayScore, status }] }
 *
 * Garanties :
 *   - Idempotence stricte : UNIQUE (connection_id, match_id, post_date) sur facebook_posts_log
 *   - Isolation par item : une erreur sur un post ne bloque pas les suivants
 *   - Seules les Pages des utilisateurs ayant sélectionné la compétition du match reçoivent le post
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { posterSurPage } from '../_shared/facebook.ts';
import { formatScoreFacebook } from '../_shared/templates.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET  = Deno.env.get('CRON_SECRET')               ?? '';
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

interface LiveMatch {
  matchId: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string; // 'inprogress' | 'finished'
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const matches: LiveMatch[] = body.matches ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const rapport = { postsPublies: 0, erreurs: 0, details: [] as string[] };

  for (const match of matches) {
    // Utilisateurs ayant sélectionné cette compétition ET une Page Facebook active
    const { data: connexions } = await supabase
      .from('user_competitions')
      .select('telegram_user_id, facebook_connections!inner(id, fb_page_id, fb_page_name, fb_page_access_token, is_active)')
      .eq('competition', match.competition)
      .eq('active', true)
      .eq('facebook_connections.is_active', true);

    for (const row of (connexions as any[]) ?? []) {
      const connexion = row.facebook_connections;
      try {
        const message = formatScoreFacebook(match);

        const { data: dejaPoste } = await supabase
          .from('facebook_posts_log')
          .select('id')
          .eq('connection_id', connexion.id)
          .eq('match_id', match.matchId)
          .eq('post_date', today)
          .maybeSingle();

        // En direct : on republie à chaque changement de score sauf si déjà posté ce même score.
        const result = await posterSurPage(connexion.fb_page_id, connexion.fb_page_access_token, message);

        await supabase.from('facebook_posts_log').upsert({
          connection_id: connexion.id,
          match_id:      match.matchId,
          post_date:     today,
          fb_post_id:    result.postId ?? null,
          status:        result.success ? 'success' : 'error',
          error_message: result.error ?? null,
        }, { onConflict: 'connection_id,match_id,post_date' });

        if (result.success) {
          rapport.postsPublies++;
          await supabase.from('facebook_connections').update({ last_post_at: new Date().toISOString() }).eq('id', connexion.id);
        } else {
          rapport.erreurs++;
          rapport.details.push(`Page "${connexion.fb_page_name}" / match ${match.matchId}: ${result.error}`);
        }
      } catch (itemErr) {
        rapport.erreurs++;
        rapport.details.push(`Exception page / match ${match.matchId}: ${String(itemErr)}`);
      }
    }
  }

  return new Response(JSON.stringify({ success: true, rapport }), { headers: { 'Content-Type': 'application/json' } });
});
