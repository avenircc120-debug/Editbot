import { useState, useEffect, useCallback } from 'react';
import type { Match, Profile } from '@/api';
import { getProfile, getMatches, toggleBroadcast } from '@/api';
import CompetitionModal from '@/components/CompetitionModal';

type Filter = 'all' | 'live' | 'today';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + formatTime(iso);
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function isFuture(iso: string): boolean {
  return new Date(iso) > new Date();
}

interface MatchCardProps {
  match: Match;
  token: string;
  onToggle: (matchId: string, active: boolean) => void;
}

function LiveMatchCard({ match, token, onToggle }: MatchCardProps) {
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
        {match.isBroadcasting && <span style={{ fontSize: 11, color: 'var(--green)', marginBottom: 2, display: 'block' }}>📡 En diffusion</span>}
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
          aria-label="Activer/désactiver diffusion"
        />
      </div>
    </div>
  );
}

function ScheduledCard({ match }: { match: Match }) {
  return (
    <div className="match-card" style={{ padding: '9px 14px' }}>
      <div className="match-info">
        <div className="match-teams">{match.home_team} vs {match.away_team}</div>
        <div className="match-time">{match.competition}</div>
      </div>
      <div className="match-time">{formatTime(match.match_date)}</div>
    </div>
  );
}

function UpcomingCard({ match }: { match: Match }) {
  return (
    <div className="match-card" style={{ padding: '9px 14px' }}>
      <div className="match-info">
        <div className="match-teams">{match.home_team} vs {match.away_team}</div>
        <div className="match-time">{match.competition}</div>
      </div>
      <div className="match-time" style={{ whiteSpace: 'nowrap' }}>{formatDate(match.match_date)}</div>
    </div>
  );
}

function FinishedCard({ match }: { match: Match }) {
  return (
    <div className="match-card finished">
      <div className="match-info">
        <div className="match-score">
          {match.home_team} &nbsp;{match.home_score ?? '–'} — {match.away_score ?? '–'}&nbsp; {match.away_team}
        </div>
        <div className="match-time">{match.competition}</div>
      </div>
    </div>
  );
}

interface Props { token: string; }

export default function MatchsTab({ token }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompModal, setShowCompModal] = useState(false);

  const loadData = useCallback(async (f = filter) => {
    setError(null);
    setLoading(true);
    try {
      const p = await getProfile(token);
      setProfile(p);
      const m = await getMatches(token, p.competitionId, f);
      setMatches(m);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, filter]);

  useEffect(() => { loadData(); }, []);

  async function changeFilter(f: Filter) {
    setFilter(f);
    setLoading(true);
    try {
      const m = await getMatches(token, profile?.competitionId, f);
      setMatches(m);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function optimisticToggle(matchId: string, active: boolean) {
    setMatches(prev => prev.map(m => m.match_id === matchId ? { ...m, isBroadcasting: active } : m));
  }

  const live      = matches.filter(m => m.status === 'inprogress');
  const todayMtch = matches.filter(m => m.status === 'scheduled' && isToday(m.match_date) && isFuture(m.match_date));
  const upcoming  = matches.filter(m => m.status === 'scheduled' && !isToday(m.match_date) && isFuture(m.match_date));
  const finished  = matches.filter(m => m.status === 'finished');

  return (
    <>
      {/* Competition header */}
      <div className="comp-header">
        <span className={`comp-name${!profile?.competition ? ' none' : ''}`}>
          {profile
            ? profile.competition
              ? `${profile.leagues.find(l => l.tsdb_id === profile.competitionId)?.flag ?? ''} ${profile.competition}`
              : 'Aucune compétition'
            : '…'}
        </span>
        <button className="btn-change" onClick={() => setShowCompModal(true)}>Changer</button>
      </div>

      {/* Filters */}
      <div className="filter-pills">
        <button className={`pill${filter === 'all' ? ' active' : ''}`} onClick={() => changeFilter('all')}>Tous</button>
        <button className={`pill${filter === 'live' ? ' active' : ''}`} onClick={() => changeFilter('live')}>🔴 En direct</button>
        <button className={`pill${filter === 'today' ? ' active' : ''}`} onClick={() => changeFilter('today')}>📅 Aujourd'hui</button>
      </div>

      {/* Error */}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={() => loadData()}>Réessayer</button>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <>
          <div className="shimmer" />
          <div className="shimmer" style={{ height: 56 }} />
          <div className="shimmer" />
        </>
      )}

      {/* Match list */}
      {!loading && !error && (
        <>
          {/* LIVE */}
          {live.length > 0 && filter !== 'today' && (
            <>
              <div className="section-header live">
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0, animation: 'pulse-live 1.5s infinite', display: 'inline-block' }} />
                En Direct
              </div>
              {live.map(m => (
                <LiveMatchCard key={m.match_id} match={m} token={token} onToggle={optimisticToggle} />
              ))}
            </>
          )}

          {/* TODAY */}
          {todayMtch.length > 0 && filter !== 'live' && (
            <>
              <div className="section-header">📅 Aujourd'hui</div>
              {todayMtch.map(m => <ScheduledCard key={m.match_id} match={m} />)}
            </>
          )}

          {/* UPCOMING */}
          {upcoming.length > 0 && filter === 'all' && (
            <>
              <div className="section-header">📆 Programme</div>
              {upcoming.map(m => <UpcomingCard key={m.match_id} match={m} />)}
            </>
          )}

          {/* FINISHED */}
          {finished.length > 0 && filter !== 'live' && (
            <>
              <div className="section-header">✓ Terminés</div>
              {finished.map(m => <FinishedCard key={m.match_id} match={m} />)}
            </>
          )}

          {/* Empty */}
          {live.length + todayMtch.length + upcoming.length + finished.length === 0 && (
            <div className="empty-state">
              <div className="emoji">⚽</div>
              <p>Aucun match trouvé pour cette compétition.</p>
            </div>
          )}
        </>
      )}

      {/* Competition modal */}
      {showCompModal && profile && (
        <CompetitionModal
          token={token}
          leagues={profile.leagues}
          currentId={profile.competitionId}
          onClose={() => setShowCompModal(false)}
          onSelected={() => loadData()}
        />
      )}
    </>
  );
}
