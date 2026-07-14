/**
 * Client API — Editbot Mini App
 * Toutes les requêtes vont vers la Supabase Edge Function mini-app-api.
 */

const API_BASE = 'https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/mini-app-api';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface League {
  tsdb_id: string;
  name: string;
  flag: string;
}

export interface FBPage {
  id: number;
  fb_page_name: string;
  last_post_at: string | null;
  created_at: string;
}

export interface Profile {
  competition: string | null;
  competitionId: string | null;
  leagues: League[];
  fbPages: FBPage[];
  activeBroadcasts: number;
}

export type MatchStatus = 'scheduled' | 'inprogress' | 'finished' | 'postponed';

export interface Match {
  match_id: string;
  home_team: string;
  away_team: string;
  match_date: string;
  status: MatchStatus;
  home_score: number | null;
  away_score: number | null;
  home_team_badge: string | null;
  away_team_badge: string | null;
  competition: string;
  tournament_id: string | null;
  isBroadcasting: boolean;
}

export interface Transaction {
  id: number;
  type: 'depot' | 'retrait';
  amount: number;
  methode: string | null;
  note: string | null;
  status: 'en_attente' | 'validee' | 'refusee';
  created_at: string;
}

export interface WalletData {
  balance: number;
  transactions: Transaction[];
}

export interface Coupon {
  id: number;
  bookmaker: string;
  code: string;
  description: string | null;
  price: number | null;
  active: boolean;
  created_at: string;
}

export interface AuthResult {
  chatId: number;
  token: string;
}

// ─── Utilitaire fetch ─────────────────────────────────────────────────────────

async function apiFetch(
  path: string,
  token: string | null,
  options?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) },
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function authenticate(initData: string): Promise<AuthResult> {
  const res = await apiFetch('/auth', null, {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Authentification échouée');
  }
  return res.json();
}

// ─── Profil & compétition ────────────────────────────────────────────────────

export async function getProfile(token: string): Promise<Profile> {
  const res = await apiFetch('/profile', token);
  if (!res.ok) throw new Error('Erreur profil');
  return res.json();
}

export async function updateCompetition(token: string, tsdbId: string): Promise<void> {
  const res = await apiFetch('/competition', token, {
    method: 'PATCH',
    body: JSON.stringify({ tsdbId }),
  });
  if (!res.ok) throw new Error('Erreur mise à jour compétition');
}

// ─── Matchs ───────────────────────────────────────────────────────────────────

export async function getMatches(
  token: string,
  competitionId?: string | null,
  filter: 'all' | 'live' | 'today' | 'week' = 'all'
): Promise<Match[]> {
  const params = new URLSearchParams({ filter });
  if (competitionId) params.set('competitionId', competitionId);
  const res = await apiFetch(`/matches?${params}`, token);
  if (!res.ok) throw new Error('Erreur matchs');
  const data = await res.json();
  return (data as { matches: Match[] }).matches;
}

// ─── Diffusion (broadcast) ───────────────────────────────────────────────────

export async function toggleBroadcast(
  token: string,
  matchId: string,
  active: boolean,
  metadata?: { competition?: string; homeTeam?: string; awayTeam?: string }
): Promise<void> {
  const res = await apiFetch('/broadcast', token, {
    method: 'POST',
    body: JSON.stringify({ matchId, active, ...metadata }),
  });
  if (!res.ok) throw new Error('Erreur toggle diffusion');
}

// ─── Facebook ─────────────────────────────────────────────────────────────────

export async function getFacebookPages(token: string): Promise<FBPage[]> {
  const res = await apiFetch('/facebook', token);
  if (!res.ok) throw new Error('Erreur pages Facebook');
  const data = await res.json();
  return (data as { pages: FBPage[] }).pages;
}

export async function disconnectFacebookPage(token: string, pageId: number): Promise<void> {
  const res = await apiFetch(`/facebook/${pageId}`, token, { method: 'DELETE' });
  if (!res.ok) throw new Error('Erreur déconnexion Facebook');
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export async function getWallet(token: string): Promise<WalletData> {
  const res = await apiFetch('/wallet', token);
  if (!res.ok) throw new Error('Erreur wallet');
  return res.json();
}

export async function requestWalletOperation(
  token: string,
  action: 'depot' | 'retrait',
  amount: number,
  methode?: string,
  note?: string
): Promise<void> {
  const res = await apiFetch('/wallet', token, {
    method: 'POST',
    body: JSON.stringify({ action, amount, methode, note }),
  });
  if (!res.ok) throw new Error('Erreur opération wallet');
}

// ─── Coupons ──────────────────────────────────────────────────────────────────

export async function getCoupons(token: string): Promise<Coupon[]> {
  const res = await apiFetch('/coupons', token);
  if (!res.ok) throw new Error('Erreur coupons');
  const data = await res.json();
  return (data as { coupons: Coupon[] }).coupons;
}

export async function addCoupon(
  token: string,
  coupon: { bookmaker: string; code: string; description?: string; price?: number }
): Promise<Coupon> {
  const res = await apiFetch('/coupons', token, {
    method: 'POST',
    body: JSON.stringify(coupon),
  });
  if (!res.ok) throw new Error('Erreur ajout coupon');
  const data = await res.json();
  return (data as { coupon: Coupon }).coupon;
}

export async function deleteCoupon(token: string, couponId: number): Promise<void> {
  const res = await apiFetch(`/coupons/${couponId}`, token, { method: 'DELETE' });
  if (!res.ok) throw new Error('Erreur suppression coupon');
}
