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

interface BroadcastRowProps {
  match: Match;
  token: string;
  onToggle: (matchId: string, active: boolean) => void;
}

function BroadcastRow({ match, token, onToggle }: BroadcastRowProps) {
  const [busy, setBusy] = useState(false);

  async function handleToggle() {
    if (busy) return;
    const next = !match.isBroadcasting;
    onToggle(match.match_id, next); // optimistic
    setBusy(true);
    try {
      await toggleBroadcast(token, match.match_id, next, {
        competition: match.competition,
        homeTeam: match.home_team,
        awayTeam: match.away_team,
      });
    } catch {
      onToggle(match.match_id, !next); // rollback
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="match-card">
      <div className="dot-live" />
      <div className="match-info">
        {match.isBroadcasting && (
          <span style={{ fontSize: 11, color: 'var(--green)', marginBottom: 2, display: 'block' }}>
            📡 Diffusé sur Facebook
          </span>
        )}
        <div className="match-score">
          {match.home_team} &nbsp;{match.home_score ?? '–'} — {match.away_score ?? '–'}&nbsp; {match.away_team}
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
  );
}

export default function FacebookTab({ token }: { token: string }) {
  const [pages, setPages] = useState<FBPage[]>([]);
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <BroadcastRow key={m.match_id} match={m} token={token} onToggle={optimisticToggle} />
      ))}
    </>
  );
}
