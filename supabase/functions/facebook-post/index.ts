/**
    * facebook-post — Diffusion automatique des scores en direct sur les Pages Facebook
    *
    * Body attendu : { matches: [{ matchId, competition, homeTeam, awayTeam, homeScore, awayScore, status }] }
    *
    * Garanties :
    *   - Idempotence stricte : UNIQUE (connection_id, match_id, post_date) sur facebook_posts_log
    *   - Isolation par item : une erreur sur un post ne bloque pas les suivants
    *   - Détection automatique des tokens révoqués/expirés → désactivation + notification Telegram
    */

    import { createClient } from 'npm:@supabase/supabase-js@2';
    import { posterSurPage } from '../_shared/facebook.ts';
    import { formatScoreFacebook } from '../_shared/templates.ts';

    const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
    const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const CRON_SECRET    = Deno.env.get('CRON_SECRET')               ?? '';
    const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')        ?? '';
    const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Codes d'erreur Facebook indiquant un token invalide/révoqué (pas une erreur temporaire)
    const FB_TOKEN_ERROR_CODES = new Set([190, 102, 467, 458, 460, 463, 464, 492]);

    interface LiveMatch {
    matchId: string;
    competition: string;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    status: string;
    }

    /** Envoie un message Telegram à l'utilisateur. */
    async function notifierUtilisateur(telegramUserId: number, texte: string): Promise<void> {
    if (!TELEGRAM_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: telegramUserId, text: texte, parse_mode: 'Markdown' }),
    });
    }

    /** Détecte si une erreur Facebook correspond à un token révoqué ou invalide. */
    function estErreurToken(erreurMessage: string): boolean {
    const codeMatch = erreurMessage.match(/#(\d+)/);
    if (codeMatch && FB_TOKEN_ERROR_CODES.has(Number(codeMatch[1]))) return true;
    const msg = erreurMessage.toLowerCase();
    return msg.includes('token') || msg.includes('session') || msg.includes('expired');
    }

    Deno.serve(async (req: Request) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const matches: LiveMatch[] = body.matches ?? [];
    const today = new Date().toISOString().slice(0, 10);

    const rapport = { postsPublies: 0, erreurs: 0, tokensRevoques: 0, details: [] as string[] };

    for (const match of matches) {
      const { data: connexions } = await supabase
        .from('user_competitions')
        .select('telegram_user_id, facebook_connections!inner(id, fb_page_id, fb_page_name, fb_page_access_token, is_active)')
        .eq('competition', match.competition)
        .eq('active', true)
        .eq('facebook_connections.is_active', true);

      for (const row of (connexions as any[]) ?? []) {
        const connexion  = row.facebook_connections;
        const telegramId = Number(row.telegram_user_id);
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
            rapport.details.push(`Page "${connexion.fb_page_name}" / match ${match.matchId}: ${result.error}`);

            // ── Token révoqué ou invalide ────────────────────────────────────
            if (estErreurToken(result.error ?? '')) {
              rapport.tokensRevoques++;

              // Désactive la connexion
              await supabase
                .from('facebook_connections')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('id', connexion.id);

              // Notifie l'utilisateur
              await notifierUtilisateur(
                telegramId,
                `⚠️ *Connexion Facebook expirée*

    Ta Page *${connexion.fb_page_name}* n'est plus accessible (accès révoqué ou token expiré).

    Les scores ne sont plus publiés. Écris-moi pour reconnecter ta Page Facebook.`
              );
            }
          }
        } catch (itemErr) {
          rapport.erreurs++;
          rapport.details.push(`Exception page / match ${match.matchId}: ${String(itemErr)}`);
        }
      }
    }

    return new Response(JSON.stringify({ success: true, rapport }), { headers: { 'Content-Type': 'application/json' } });
    });
    