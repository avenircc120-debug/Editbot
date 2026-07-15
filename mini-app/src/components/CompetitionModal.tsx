import { useState, useEffect } from 'react';
import type { League, MatchCounts } from '@/api';
import { updateCompetition, getMatchCounts } from '@/api';

interface Props {
  token: string;
  leagues: League[];
  currentId: string | null;
  onClose: () => void;
  onSelected: () => void;
}

export default function CompetitionModal({ token, leagues, currentId, onClose, onSelected }: Props) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [counts, setCounts] = useState<MatchCounts>({ liveCounts: {}, scheduledCounts: {} });
  const [liveOnly, setLiveOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function load() {
      getMatchCounts(token).then(c => { if (!cancelled) setCounts(c); }).catch(() => {});
    }

    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token]);

  async function select(tsdbId: string) {
    if (tsdbId === currentId) { onClose(); return; }
    setUpdating(tsdbId);
    try {
      await updateCompetition(token, tsdbId);
      onSelected();
      onClose();
    } catch {
      setUpdating(null);
    }
  }

  const totalLive = Object.values(counts.liveCounts).reduce((a, b) => a + b, 0);
  const visibleLeagues = liveOnly
    ? leagues.filter(l => (counts.liveCounts[l.tsdb_id] ?? 0) > 0)
    : leagues;

  return (
    <div className="modal-overlay">
      <div className="modal-header">
        <span className="modal-title">Choisir ta compétition</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className={`btn-live-toggle${liveOnly ? ' active' : ''}`}
            onClick={() => setLiveOnly(v => !v)}
            aria-pressed={liveOnly}
          >
            <span className="live-dot" />
            Live{totalLive > 0 ? ` (${totalLive})` : ''}
          </button>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="modal-list">
        {visibleLeagues.map(l => {
          const liveCount      = counts.liveCounts[l.tsdb_id]      ?? 0;
          const scheduledCount = counts.scheduledCounts[l.tsdb_id] ?? 0;
          return (
            <div
              key={l.tsdb_id}
              className="league-row"
              onClick={() => !updating && select(l.tsdb_id)}
              style={{ opacity: updating && updating !== l.tsdb_id ? 0.5 : 1 }}
            >
              <span className="league-flag">{l.flag}</span>
              <span className="league-name">{l.name}</span>
              <div className="league-badges">
                {scheduledCount > 0 && (
                  <span className="scheduled-badge">{scheduledCount}</span>
                )}
                {liveCount > 0 && (
                  <span className="live-badge">
                    <span className="live-dot" />
                    {liveCount}
                  </span>
                )}
              </div>
              {updating === l.tsdb_id ? (
                <div className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
              ) : l.tsdb_id === currentId ? (
                <span className="checkmark">✓</span>
              ) : null}
            </div>
          );
        })}
        {visibleLeagues.length === 0 && (
          <div className="empty-state">
            <div className="emoji">⚽</div>
            <p>Aucun match en direct pour le moment.</p>
          </div>
        )}
      </div>
    </div>
  );
}
