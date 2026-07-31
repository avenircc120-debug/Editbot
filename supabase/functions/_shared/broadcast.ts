import { posterSurPage } from './facebook.ts';

// ─── Token expiry detection ──────────────────────────────────────────────────

/** Facebook error codes that indicate an invalid / expired / revoked token. */
export const FB_TOKEN_ERROR_CODES = new Set([190, 102, 467, 458, 460, 463, 464, 492]);

/**
 * Returns true when the error string from a Facebook Graph API call contains
 * a code that signals a revoked or expired access token.
 */
export function estErreurToken(erreurMessage: string): boolean {
  const codes = erreurMessage.match(/\b(\d+)\b/g);
  if (codes) {
    for (const c of codes) {
      if (FB_TOKEN_ERROR_CODES.has(Number(c))) return true;
    }
  }
  return false;
}

export interface FacebookPageForBroadcast {
  fb_page_id: string;
  fb_page_name: string;
  fb_page_access_token: string;
}

export interface BroadcastPageResult {
  fb_page_id: string;
  pageName: string;
  success: boolean;
  postId?: string;
  error?: string;
}

/**
 * Page IDs come from JSONB in Supabase and from browser JSON payloads.
 * Always compare them as trimmed strings so a numeric/string mismatch cannot
 * silently exclude a page.
 */
export function normalisePageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  )];
}

/**
 * An omitted/empty list is kept backward compatible as "all active pages".
 * A non-empty list is always treated as an explicit allow-list.
 */
export function selectBroadcastPages(
  pages: FacebookPageForBroadcast[],
  requestedPageIds: string[],
): FacebookPageForBroadcast[] {
  if (requestedPageIds.length === 0) return pages;

  const wanted = new Set(requestedPageIds);
  return pages.filter((page) => wanted.has(String(page.fb_page_id).trim()));
}

export async function publishToBroadcastPages(
  pages: FacebookPageForBroadcast[],
  message: string,
): Promise<BroadcastPageResult[]> {
  return Promise.all(
    pages.map(async (page): Promise<BroadcastPageResult> => {
      const result = await posterSurPage(page.fb_page_id, page.fb_page_access_token, message);
      return {
        fb_page_id: page.fb_page_id,
        pageName: page.fb_page_name,
        success: result.success,
        postId: result.postId,
        error: result.error,
      };
    }),
  );
}