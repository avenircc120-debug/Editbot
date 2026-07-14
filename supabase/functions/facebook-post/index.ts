/**
 * facebook-post — Diffusion automatique des scores en direct sur les Pages Facebook
 *
 * Body attendu : { matches: [{ matchId, competition, homeTeam, awayTeay, homeScore, awayScore, status }] }
 *
 * Flux : fetch-matches détecte un changement de score → appelle cette fonction →
 *        on cherche les utilisateurs qui ont activé explicitement CE match dans
 *        broadcast_selections → on poste sur leurs Pages Facebook actives.
 *
 * Garanties :
 *   - Idempotence : UNIQUE (connection_id, match_id, post_date) sur facebook_posts_log
 *   - Isolation par item : une erreur ne bloque pas les autres
 *   - Tokens révoqués → désactivation auto + notification Telegram
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { posterSurPage } from '../_shared/facebook.ts';
import { formatScoreFacebook } from '../_shared/templates.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET    = Deno.env.get('CRON_SECRET')               ?? '';
const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

// Codes d'erreur Facebook indiquant un token invalide/révoqué
const FB_TOKEN_ERROR_CODES = new Set([190, 102, 467, 458, 460, 463, 464, 492]);

interface LiveMatch {
  matchId:     string;
  competition: string;
  homeTeam:    string;
  awayTeam:    string;
  homeScore:   number;
  awayScore:   number;
  status:      string;
}

async function notifierUtilisateur(telegramUserId: number, texte: string): Promise<void> {
  if (!TELEGRAM_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: telegramUserId, text: texte, parse_mode: 'Markdown' }),
  });
}

function estErreurToken(erreurMessage: string): boolean {
  const codes = erreurMessage.match(/\b(\d+)\b/g);
  if (codes) {
    for (const c of codes) {
      if (FB_TOKEN_ERROR_CODES.has(Number(c))) return true;
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const body                 = await req.json().catch(() => ({}));
  const matches: LiveMatch[] = body.matches ?? [];
  const today                = new Date().toISOString().slice(0, 10);

  const rapport = { postsPublies: 0, erreurs: 0, tokensRevoques: 0, details: [] as string[] };

  for (const match of matches) {
    // ── Étape 1 : utilisateurs ayant activé CE match spécifiquement ────────────
    // On ne diffuse que pour les utilisateurs qui ont toggle ON ce match
    const { data: selections } = await supabase
      .from('broadcast_selections')
      .select('telegram_user_id')
      .eq('match_id', match.matchId)
      .eq('is_active', true);

    const userIds = (selections ?? []).map((r: { telegram_user_id: number }) => r.telegram_user_id);

    if (!userIds.length) {
      rapport.details.push(`Aucun broadcast actif pour ${match.matchId}`);
      continue;
    }

    // ── Étape 2 : Pages Facebook actives de ces utilisateurs ───────────────────
    const { data: connexions } = await supabase
      .from('facebook_connections')
      .select('id, telegram_user_id, fb_page_id, fb_page_name, fb_page_access_token')
      .eq('is_active', true)
      .in('telegram_user_id', userIds);

    for (const connexion of (connexions as Array<{
      id: number;
      telegram_user_id: number;
      fb_page_id: string;
      fb_page_name: string;
      fb_page_access_token: string;
    }>) ?? []) {
      const telegramId = Number(connexion.telegram_user_id);
      try {
        const message = formatScoreFacebook(match);
        const result  = await posterSurPage(connexion.fb_page_id, connexion.fb_page_access_token, message);

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
          await supabase
            .from('facebook_connections')
            .update({ last_post_at: new Date().toISOString() })
            .eq('id', connexion.id);
        } else {
          rapport.erreurs++;
          rapport.details.push(`"${connexion.fb_page_name}" / ${match.matchId}: ${result.error}`);

          if (estErreurToken(result.error ?? '')) {
            rapport.tokensRevoques++;
            await supabase
              .from('facebook_connections')
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq('id', connexion.id);

            await notifierUtilisateur(
              telegramId,
              `⚠️ *Connexion Facebook expirée*\n\nTa Page *${connexion.fb_page_name}* n'est plus accessible (token révoqué).\n\nOuvre la Mini App pour reconnecter ta Page.`,
            );
          }
        }
      } catch (err) {
        rapport.erreurs++;
        rapport.details.push(`Exception / ${match.matchId}: ${String(err)}`);
      }
    }
  }

  return new Response(JSON.stringify({ success: true, rapport }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
