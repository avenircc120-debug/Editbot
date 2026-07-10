/**
 * _shared/facebook.ts — Helpers Graph API Meta v20.0
 *
 * Gère :
 *   - Génération URL OAuth Meta
 *   - Échange code → long-lived token (60 jours)
 *   - Récupération des Pages Facebook
 *   - Publication sur une Page
 *   - Formatage des pronostics pour Facebook
 */

const FB_APP_ID     = Deno.env.get('FACEBOOK_APP_ID')     ?? '';
const FB_APP_SECRET = Deno.env.get('FACEBOOK_APP_SECRET') ?? '';
const FB_GRAPH_URL  = 'https://graph.facebook.com/v20.0';

/** Génère l'URL d'autorisation OAuth Meta */
export function genererUrlOAuth(state: string): string {
  const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/facebook-oauth`;
  const params = new URLSearchParams({
    client_id:     FB_APP_ID,
    redirect_uri:  redirectUri,
    scope:         'pages_manage_posts,pages_read_engagement,pages_show_list',
    state,
    response_type: 'code',
  });
  return `https://www.facebook.com/dialog/oauth?${params}`;
}

/** Échange un code d'autorisation contre un short-lived token */
export async function echangerCode(code: string): Promise<string | null> {
  const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/facebook-oauth`;
  const res  = await fetch(
    `${FB_GRAPH_URL}/oauth/access_token?client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}` +
    `&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`
  );
  return (await res.json()).access_token ?? null;
}

/** Convertit un short-lived token en long-lived token (60 jours) */
export async function prolongerToken(shortToken: string): Promise<string> {
  const res  = await fetch(
    `${FB_GRAPH_URL}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${shortToken}`
  );
  return (await res.json()).access_token ?? shortToken;
}

export interface PageInfo {
  id:           string;
  name:         string;
  access_token: string;
}

/** Récupère les Pages Facebook administrées par l'utilisateur */
export async function recupererPages(userToken: string): Promise<PageInfo[]> {
  const res  = await fetch(`${FB_GRAPH_URL}/me/accounts?access_token=${userToken}`);
  return ((await res.json()).data ?? []) as PageInfo[];
}

/** Récupère l'ID Facebook de l'utilisateur */
export async function recupererFbUserId(userToken: string): Promise<string | null> {
  const res  = await fetch(`${FB_GRAPH_URL}/me?access_token=${userToken}`);
  return (await res.json()).id ?? null;
}

/** Publie un message texte sur une Page Facebook */
export async function posterSurPage(
  pageAccessToken: string,
  pageId: string,
  message: string,
): Promise<{ success: boolean; postId?: string; error?: string }> {
  const res  = await fetch(`${FB_GRAPH_URL}/${pageId}/feed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, access_token: pageAccessToken }),
  });
  const d = await res.json();
  return d.id
    ? { success: true, postId: d.id }
    : { success: false, error: d.error?.message ?? 'Erreur inconnue' };
}

export interface PronosticFB {
  competition:      string;
  home_team:        string;
  away_team:        string;
  match_date:       string;
  pronostic_type:   string;
  pronostic_valeur: string;
  cote_conseille:   number | null;
  fiabilite:        number | null;
  analyse_texte:    string | null;
}

/** Formate une liste de pronostics en message Facebook */
export function formaterPronosticFacebook(pronos: PronosticFB[]): string {
  const date = new Date(pronos[0].match_date).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });

  const lignes: string[] = [
    '⚽ PRONOSTIC EDITBOT', '',
    `🏆 ${pronos[0].competition}`,
    `${pronos[0].home_team} vs ${pronos[0].away_team}`,
    `📅 ${date}`, '',
  ];

  for (const p of pronos) {
    const cote = p.cote_conseille ? ` (cote ${p.cote_conseille})` : '';
    lignes.push(`✅ ${p.pronostic_type} : ${p.pronostic_valeur}${cote} — Fiabilité ${p.fiabilite ?? '?'}%`);
  }

  if (pronos[0].analyse_texte) {
    lignes.push('', `💬 ${pronos[0].analyse_texte.slice(0, 280)}`);
  }

  lignes.push(
    '',
    '📊 Tous les pronostics : t.me/editbot',
    '',
    `#pronostic #paris #foot #${pronos[0].competition.replace(/\s+/g, '')}`,
  );

  return lignes.join('\n');
}
