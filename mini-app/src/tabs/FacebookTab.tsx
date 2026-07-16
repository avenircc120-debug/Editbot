import { useState, useEffect, useCallback } from 'react';
import type { FBPage, Match } from '@/api';
import {
  getProfile,
  getMatches,
  toggleBroadcast,
  getFacebookConnectUrl,
  disconnectFacebookPage,
} from '@/api';

function openExternal(url: string) {
  if (window.Telegram?.WebApp?.openLink) {
    window.Telegram.WebApp.openLink(url, { try_instant_view: false });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ── Sélecteur de pages ────────────────────────────────────────────────────────

interface PagePickerProps {
  pages: FBPage[];
  onConfirm: (pageIds: string[]) => void;
  onCancel: () => void;
}

function PagePicker({ pages, onConfirm, onCancel }: PagePickerProps) {
  // Aucune page pré-cochée : l'utilisateur choisit explicitement
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
            <span style={{ fontSize: 15 }}>{page.fb_page_name}</span>
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
          >
            {selected.size === 0 ? 'Sélectionner une page' : `✓ Diffuser (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PageRow ───────────────────────────────────────────────────────────────────

interface PageRowProps {
  page: FBPage;
  onDisconnect: (page: FBPage) => void;
}

function PageRow({ page, onDisconnect }: PageRowProps) {
  return (
    <div className="fb-page-row">
      <div className="fb-icon">f</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fb-page-name">{page.fb_page_name}</div>
        <div className="fb-page-meta">
          {page.last_post_at
            ? `Dernier post : ${new Date(page.last_post_at).toLocaleDateString('fr-FR')}`
            : 'Jamais posté'}
        </div>
      </div>
      <button className="btn-disconnect" onClick={() => onDisconnect(page)}>
        Délier
      </button>
    </div>
  );
}

// ── BroadcastRow ──────────────────────────────────────────────────────────────

interface BroadcastRowProps {
  match: Match;
  token: string;
  pages: FBPage[];
  onToggle: (matchId: string, active: boolean) => void;
}

function BroadcastRow({ match, token, pages, onToggle }: BroadcastRowProps) {
  const [busy, setBusy]             = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  // `activate` capturé au clic → pas de closure stale si données rafraîchies pendant le picker
  async function doToggle(activate: boolean, pageIds?: string[]) {
    onToggle(match.match_id, activate);
    setBusy(true);
    try {
      await toggleBroadcast(token, match.match_id, activate, {
        competition: match.competition,
        homeTeam:    match.home_team,
        awayTeam:    match.away_team,
        pageIds:     activate ? (pageIds ?? []) : undefined,
      });
    } catch {
      onToggle(match.match_id, !activate);
    } finally {
      setBusy(false);
    }
  }

  function handleToggle() {
    if (busy) return;
    const activate = !match.isBroadcasting;
    // Picker uniquement à l'activation, si plusieurs pages
    if (activate && pages.length > 1) {
      setShowPicker(true);
      return;
    }
    doToggle(activate, activate && pages.length === 1 ? [pages[0].fb_page_id] : undefined);
  }

  return (
    <>
      <div className="match-card">
        <div className="dot-live" />
        <div className="match-info">
          {match.isBroadcasting && (
            <span style={{ fontSize: 11, color: 'var(--green)', marginBottom: 2, display: 'block' }}>
              📡 Diffusé sur Facebook
            </span>
          )}
          <div className="match-score">
            {match.home_team}&nbsp;{match.home_score ?? '–'} — {match.away_score ?? '–'}&nbsp;{match.away_team}
          </div>
          <div className="match-time">{match.competition}</div>
        </div>
        <div className="match-right">
          <span className="broadcast-label">Diffuser</span>
          <button
            className={`toggle${match.isBroadcasting ? ' on' : ''}`}
            onClick={handleToggle}
            disabled={busy}
            aria-label="Activer/désactiver la diffusion Facebook"
          />
        </div>
      </div>

      {showPicker && (
        <PagePicker
          pages={pages}
          onConfirm={(pageIds) => { setShowPicker(false); doToggle(true, pageIds); }}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  );
}

// ── Tab principal ─────────────────────────────────────────────────────────────

export default function FacebookTab({ token }: { token: string }) {
  const [pages,       setPages]       = useState<FBPage[]>([]);
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [connecting,  setConnecting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const profile = await getProfile(token);
      setPages(profile.fbPages);
      const matches = await getMatches(token, profile.competitionId, 'live');
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
      const url = await getFacebookConnectUrl(token);
      openExternal(url);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(page: FBPage) {
    if (!window.confirm(`Délier la page "${page.fb_page_name}" ? Elle arrêtera de recevoir les scores en direct.`)) return;
    try {
      await disconnectFacebookPage(token, page.id);
      setPages(prev => prev.filter(p => p.id !== page.id));
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  function optimisticToggle(matchId: string, active: boolean) {
    setLiveMatches(prev => prev.map(m => m.match_id === matchId ? { ...m, isBroadcasting: active } : m));
  }

  return (
    <>
      <div className="section-header" style={{ marginTop: 4 }}>
        Pages Facebook
        <span className="badge">{pages.length}</span>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={load}>Réessayer</button>
        </div>
      )}

      {loading && <div className="shimmer" style={{ height: 58 }} />}

      {!loading && pages.length === 0 && !error && (
        <div className="empty-state">
          <div className="emoji">📄</div>
          <p>Aucune page Facebook connectée pour l'instant.</p>
        </div>
      )}

      {!loading && pages.map(page => (
        <div className="card" key={page.id} style={{ padding: '4px 14px' }}>
          <PageRow page={page} onDisconnect={handleDisconnect} />
        </div>
      ))}

      <button className="btn-connect-fb" onClick={handleConnect} disabled={connecting}>
        {connecting ? 'Ouverture…' : '+ Lier une nouvelle page Facebook'}
      </button>

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
        <BroadcastRow key={m.match_id} match={m} token={token} pages={pages} onToggle={optimisticToggle} />
      ))}
    </>
  );
}
