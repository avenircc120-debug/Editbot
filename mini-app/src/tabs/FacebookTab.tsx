import { useState, useEffect, useCallback } from 'react';
import type { FBPage, Match } from '@/api';
import {
  getProfile,
  getMatches,
  toggleBroadcast,
  getFacebookConnectUrl,
  disconnectFacebookPage,
  disconnectFacebookAccount,
} from '@/api';

function openExternal(url: string) {
  if (window.Telegram?.WebApp?.openLink) {
    window.Telegram.WebApp.openLink(url, { try_instant_view: false });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ── Groupement des pages par compte Facebook ──────────────────────────────────

interface FbAccount {
  fbUserId: string;
  fbUserName: string;
  pages: FBPage[];
}

function groupByAccount(pages: FBPage[]): FbAccount[] {
  const map = new Map<string, FbAccount>();
  for (const page of pages) {
    const uid = page.fb_user_id ?? 'unknown';
    if (!map.has(uid)) {
      map.set(uid, {
        fbUserId:   uid,
        fbUserName: page.fb_user_name || 'Compte Facebook',
        pages:      [],
      });
    }
    map.get(uid)!.pages.push(page);
  }
  return [...map.values()];
}

// ── Sélecteur de pages (pour activer la diffusion) ────────────────────────────

interface PagePickerProps {
  pages: FBPage[];
  onConfirm: (pageIds: string[]) => void;
  onCancel: () => void;
}

function PagePicker({ pages, onConfirm, onCancel }: PagePickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)',
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--card, #1c1c1e)', borderRadius: '16px 16px 0 0',
        width: '100%', maxWidth: 480,
        padding: '20px 16px',
        paddingBottom: 'calc(var(--nav-h, 64px) + 20px)',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: 'var(--text, #fff)' }}>
          📘 Sur quelle(s) page(s) diffuser ?
        </div>
        {pages.map(page => (
          <label key={page.fb_page_id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 4px', cursor: 'pointer',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            color: 'var(--text, #fff)',
          }}>
            <input
              type="checkbox"
              checked={selected.has(page.fb_page_id)}
              onChange={() => toggle(page.fb_page_id)}
              style={{ width: 20, height: 20, accentColor: 'var(--green, #30d158)', cursor: 'pointer', flexShrink: 0 }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15 }}>{page.fb_page_name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted, #8b949e)' }}>{page.fb_user_name || 'Compte Facebook'}</div>
            </div>
          </label>
        ))}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: '13px 0', borderRadius: 10, border: 'none',
            background: 'rgba(255,255,255,0.1)', color: 'var(--text, #fff)',
            fontSize: 15, cursor: 'pointer',
          }}>Annuler</button>
          <button
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
            style={{
              flex: 2, padding: '13px 0', borderRadius: 10, border: 'none',
              background: selected.size === 0 ? 'rgba(255,255,255,0.1)' : 'var(--green, #30d158)',
              color: selected.size === 0 ? 'rgba(255,255,255,0.4)' : '#000',
              fontSize: 15, fontWeight: 600, cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
            }}
          >{selected.size === 0 ? 'Sélectionner une page' : `✓ Diffuser (${selected.size})`}</button>
        </div>
      </div>
    </div>
  );
}

// ── Ligne de match avec activation de diffusion ───────────────────────────────

interface BroadcastRowProps {
  match: Match;
  token: string;
  pages: FBPage[];
  onToggle: (matchId: string, active: boolean, pageIds?: string[]) => void;
}

function BroadcastRow({ match, token, pages, onToggle }: BroadcastRowProps) {
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);

  async function doToggle(activate: boolean, pageIds?: string[]) {
    setBusy(true);
    try {
      await toggleBroadcast(token, match.match_id, activate, pageIds,
        match.competition, match.home_team, match.away_team);
      onToggle(match.match_id, activate, pageIds);
    } catch { /* silent */ }
    finally { setBusy(false); }
  }

  function handleToggle() {
    if (match.isBroadcasting) {
      doToggle(false);
    } else if (pages.length === 1) {
      doToggle(true, [pages[0].fb_page_id]);
    } else if (pages.length > 1) {
      setPicker(true);
    } else {
      doToggle(true);
    }
  }

  return (
    <>
      <div className="fb-page-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fb-page-name" style={{ fontSize: 13 }}>
            {match.home_team} — {match.away_team}
          </div>
          <div className="fb-page-meta">{match.competition}</div>
        </div>
        <button
          disabled={busy}
          onClick={handleToggle}
          style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
            background: match.isBroadcasting ? 'rgba(248,81,73,0.15)' : 'rgba(63,185,80,0.15)',
            color: match.isBroadcasting ? 'var(--red, #f85149)' : 'var(--green, #3fb950)',
            flexShrink: 0,
          }}
        >
          {busy ? '…' : match.isBroadcasting ? 'Arrêter' : 'Diffuser'}
        </button>
      </div>
      {picker && (
        <PagePicker
          pages={pages}
          onConfirm={(ids) => { setPicker(false); doToggle(true, ids); }}
          onCancel={() => setPicker(false)}
        />
      )}
    </>
  );
}

// ── Carte d'un compte Facebook avec ses pages ─────────────────────────────────

interface AccountCardProps {
  account: FbAccount;
  onDisconnectPage: (page: FBPage) => Promise<void>;
  onDisconnectAccount: (account: FbAccount) => Promise<void>;
}

function AccountCard({ account, onDisconnectPage, onDisconnectAccount }: AccountCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [removing, setRemoving] = useState(false);

  async function handleRemoveAccount() {
    if (!window.confirm(
      `Déconnecter le compte "${account.fbUserName}" ?\n` +
      `Toutes ses pages (${account.pages.length}) arrêteront de recevoir les scores.`
    )) return;
    setRemoving(true);
    try { await onDisconnectAccount(account); }
    finally { setRemoving(false); }
  }

  return (
    <div className="card" style={{ margin: '8px 12px', overflow: 'hidden' }}>
      {/* En-tête du compte */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        borderBottom: expanded ? '1px solid var(--border, #30363d)' : 'none',
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
          background: 'var(--blue, #1877F2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: 16,
        }}>
          {account.fbUserName.charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text, #e6edf3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {account.fbUserName}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted, #8b949e)' }}>
            {account.pages.length} page{account.pages.length > 1 ? 's' : ''}
          </div>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'none', border: 'none', color: 'var(--muted, #8b949e)',
            fontSize: 18, cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
          }}
          aria-label={expanded ? 'Réduire' : 'Développer'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          onClick={handleRemoveAccount}
          disabled={removing}
          style={{
            background: 'rgba(248,81,73,0.12)', border: '1px solid rgba(248,81,73,0.3)',
            color: 'var(--red, #f85149)', borderRadius: 8,
            fontSize: 11, fontWeight: 600, padding: '5px 10px',
            cursor: removing ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {removing ? '…' : 'Déconnecter'}
        </button>
      </div>

      {/* Liste des pages du compte */}
      {expanded && account.pages.map((page, idx) => (
        <div key={page.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          borderBottom: idx < account.pages.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, background: '#1877F2',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 13, flexShrink: 0,
          }}>f</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text, #e6edf3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {page.fb_page_name}
            </div>
            {page.last_post_at && (
              <div style={{ fontSize: 11, color: 'var(--muted, #8b949e)' }}>
                Dernier post : {new Date(page.last_post_at).toLocaleDateString('fr-FR')}
              </div>
            )}
          </div>
          <button
            onClick={() => onDisconnectPage(page)}
            style={{
              background: 'none', border: 'none',
              color: 'var(--muted, #8b949e)', fontSize: 18,
              cursor: 'pointer', padding: '2px 4px', lineHeight: 1,
            }}
            title="Retirer cette page"
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ── Onglet principal Facebook ─────────────────────────────────────────────────

export default function FacebookTab({ token }: { token: string }) {
  const [pages,       setPages]       = useState<FBPage[]>([]);
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [connecting,  setConnecting]  = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [profile, matches] = await Promise.all([
        getProfile(token),
        getMatches(token, null, 'live'),
      ]);
      setPages(profile.fbPages);
      setLiveMatches(matches);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await getFacebookConnectUrl(token, accounts.length > 0);
      openExternal(url);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnectPage(page: FBPage) {
    if (!window.confirm(`Retirer la page "${page.fb_page_name}" ?`)) return;
    try {
      await disconnectFacebookPage(token, page.id);
      setPages(prev => prev.filter(p => p.id !== page.id));
    } catch { /* silent */ }
  }

  async function handleDisconnectAccount(account: FbAccount) {
    try {
      await disconnectFacebookAccount(token, account.fbUserId);
      setPages(prev => prev.filter(p => p.fb_user_id !== account.fbUserId));
    } catch { /* silent */ }
  }

  function optimisticToggle(matchId: string, active: boolean) {
    setLiveMatches(prev => prev.map(m =>
      m.match_id === matchId ? { ...m, isBroadcasting: active } : m
    ));
  }

  const accounts = groupByAccount(pages);

  return (
    <>
      {/* ── En-tête ──────────────────────────────────────────────────────── */}
      <div className="section-header" style={{ marginTop: 4 }}>
        Comptes Facebook
        <span className="badge">{accounts.length}</span>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={load}>Réessayer</button>
        </div>
      )}

      {loading && (
        <>
          <div className="shimmer" style={{ height: 62, margin: '8px 12px', borderRadius: 10 }} />
          <div className="shimmer" style={{ height: 62, margin: '8px 12px', borderRadius: 10 }} />
        </>
      )}

      {/* ── Comptes groupés ──────────────────────────────────────────────── */}
      {!loading && accounts.length === 0 && !error && (
        <div className="empty-state">
          <div className="emoji">📘</div>
          <p>Aucun compte Facebook connecté.<br/>Ajoute un compte pour diffuser les scores.</p>
        </div>
      )}

      {!loading && accounts.map(account => (
        <AccountCard
          key={account.fbUserId}
          account={account}
          onDisconnectPage={handleDisconnectPage}
          onDisconnectAccount={handleDisconnectAccount}
        />
      ))}

      {/* ── Bouton ajouter un compte ─────────────────────────────────────── */}
      <button
        className="btn-connect-fb"
        onClick={handleConnect}
        disabled={connecting}
        style={{ marginTop: accounts.length > 0 ? 4 : 0 }}
      >
        {connecting ? 'Ouverture…' : accounts.length === 0 ? '+ Connecter un compte Facebook' : '+ Ajouter un autre compte Facebook'}
      </button>

      {accounts.length > 0 && (
        <div style={{ padding: '4px 16px 8px', fontSize: 11, color: 'var(--muted, #8b949e)' }}>
          Chaque compte peut avoir plusieurs pages. Les scores seront diffusés sur les pages que tu actives dans les matchs en direct.
        </div>
      )}

      {/* ── Matchs en direct avec diffusion ─────────────────────────────── */}
      <div className="section-header live" style={{ marginTop: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0, animation: 'pulse-live 1.5s infinite', display: 'inline-block' }} />
        Diffusion des matchs en direct
      </div>

      {!loading && liveMatches.length === 0 && !error && (
        <div className="empty-state">
          <div className="emoji">⚽</div>
          <p>Aucun match en direct pour le moment.</p>
        </div>
      )}

      {!loading && liveMatches.map(m => (
        <div className="card" key={m.match_id} style={{ padding: '4px 14px' }}>
          <BroadcastRow match={m} token={token} pages={pages} onToggle={optimisticToggle} />
        </div>
      ))}
    </>
  );
}
