export interface Env {
  WORKER_AUTH_TOKEN: string;
}

const ESPN_HOST = 'site.api.espn.com';
const ESPN_PATH_PREFIX = '/apis/site/v2/sports/soccer/';

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function parseAllowedTarget(rawTarget: string): URL | null {
  try {
    const target = new URL(rawTarget);
    const allowedPath = target.pathname.startsWith(ESPN_PATH_PREFIX) && target.pathname.endsWith('/scoreboard');
    if (target.protocol !== 'https:' || target.hostname !== ESPN_HOST || !allowedPath) return null;
    return target;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'editbot-espn-proxy' });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    }

    if (!env.WORKER_AUTH_TOKEN) {
      return json({ error: 'Worker secret is not configured' }, 503);
    }

    const authorization = request.headers.get('Authorization') ?? '';
    if (authorization !== `Bearer ${env.WORKER_AUTH_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }

    const target = parseAllowedTarget(requestUrl.searchParams.get('url') ?? '');
    if (!target) {
      return json({ error: 'Only HTTPS ESPN soccer scoreboard URLs are allowed' }, 400);
    }

    try {
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.espn.com',
          Referer: 'https://www.espn.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        },
        cf: { cacheEverything: true, cacheTtl: 10 },
      });

      const headers = new Headers({
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
        'Cache-Control': upstream.ok ? 'public, max-age=10, s-maxage=10' : 'no-store',
        'X-Proxy': 'editbot-espn-cloudflare',
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (error) {
      console.error('[editbot-espn-proxy] upstream error', error);
      return json({ error: 'Unable to reach ESPN' }, 502, { 'Cache-Control': 'no-store' });
    }
  },
};
