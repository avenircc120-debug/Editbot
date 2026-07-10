/**
    * facebook-post — Publication cron des pronostics sur les Pages Facebook
    * Déclenché chaque matin à 8h00 UTC via Supabase cron.
    */

    import { createClient } from 'npm:@supabase/supabase-js@2';
    import { posterSurPage, formaterPronosticFacebook } from '../_shared/facebook.ts';

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const CRON_SECRET  = Deno.env.get('CRON_SECRET') ?? '';
    const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

    Deno.serve(async (req: Request) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const rapport = { postsPublies: 0, erreurs: 0, sautes: 0, connexions: 0 };

    try {
      const { data: connexions } = await supabase
        .from('facebook_connections')
        .select('id, fb_page_id, fb_page_name, fb_page_access_token')
        .eq('is_active', true);

      if (!connexions?.length) {
        return new Response(JSON.stringify({ message: 'Aucune connexion active', rapport }), { status: 200 });
      }
      rapport.connexions = connexions.length;

      const now    = new Date();
      const finJour = new Date(now);
      finJour.setHours(23, 59, 59, 999);

      const { data: pronos } = await supabase
        .from('pronostics_finaux')
        .select('match_id, competition, home_team, away_team, match_date, pronostic_type, pronostic_valeur, cote_conseille, fiabilite, analyse_texte')
        .gte('match_date', now.toISOString())
        .lte('match_date', finJour.toISOString())
        .gte('fiabilite', 70)
        .gte('expires_at', now.toISOString())
        .order('fiabilite', { ascending: false })
        .limit(30);

      if (!pronos?.length) {
        return new Response(JSON.stringify({ message: 'Aucun pronostic du jour (fiabilité ≥ 70)', rapport }), { status: 200 });
      }

      // Grouper par match (max 3 pronostics)
      const parMatch = new Map<string, typeof pronos>();
      for (const p of pronos) {
        if (!parMatch.has(p.match_id)) parMatch.set(p.match_id, []);
        const l = parMatch.get(p.match_id)!;
        if (l.length < 3) l.push(p);
      }

      for (const connexion of connexions) {
        for (const [matchId, matchPronos] of parMatch) {
          const { data: dejaPublie } = await supabase
            .from('facebook_posts_log')
            .select('id')
            .eq('connection_id', connexion.id)
            .eq('match_id', matchId)
            .eq('status', 'success')
            .maybeSingle();

          if (dejaPublie) { rapport.sautes++; continue; }

          const message = formaterPronosticFacebook(matchPronos as any);
          const result  = await posterSurPage(connexion.fb_page_access_token, connexion.fb_page_id, message);

          await supabase.from('facebook_posts_log').upsert({
            connection_id:  connexion.id,
            match_id:       matchId,
            pronostic_type: matchPronos.map(p => p.pronostic_type).join(','),
            fb_post_id:     result.postId,
            status:         result.success ? 'success' : 'error',
            error_message:  result.error ?? null,
          }, { onConflict: 'connection_id,match_id,pronostic_type' });

          if (result.success) {
            rapport.postsPublies++;
            await supabase.from('facebook_connections')
              .update({ last_post_at: new Date().toISOString() })
              .eq('id', connexion.id);
          } else {
            rapport.erreurs++;
            console.error(`[facebook-post] Erreur ${connexion.fb_page_name}:`, result.error);
          }
        }
      }

      return new Response(JSON.stringify({ success: true, rapport }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error('[facebook-post] Fatal:', err);
      return new Response(JSON.stringify({ error: String(err), rapport }), { status: 500 });
    }
    });
    