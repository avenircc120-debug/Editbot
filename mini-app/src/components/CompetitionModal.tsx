import { useState, useEffect } from 'react';
    import type { League } from '@/api';
    import { updateCompetition, getLiveCounts } from '@/api';

    interface Props {
    token: string;
    leagues: League[];
    currentId: string | null;
    onClose: () => void;
    onSelected: () => void;
    }

    export default function CompetitionModal({ token, leagues, currentId, onClose, onSelected }: Props) {
    const [updating, setUpdating] = useState<string | null>(null);
    const [liveCounts, setLiveCounts] = useState<Record<string, number>>({});

    useEffect(() => {
      getLiveCounts(token).then(setLiveCounts).catch(() => {});
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

    return (
      <div className="modal-overlay">
        <div className="modal-header">
          <span className="modal-title">Choisir ta compétition</span>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-list">
          {leagues.map(l => {
            const count = liveCounts[l.tsdb_id] ?? 0;
            return (
              <div
                key={l.tsdb_id}
                className="league-row"
                onClick={() => !updating && select(l.tsdb_id)}
                style={{ opacity: updating && updating !== l.tsdb_id ? 0.5 : 1 }}
              >
                <span className="league-flag">{l.flag}</span>
                <span className="league-name">{l.name}</span>
                {count > 0 && (
                  <span className="live-badge">
                    <span className="live-dot" />
                    {count}
                  </span>
                )}
                {updating === l.tsdb_id ? (
                  <div className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                ) : l.tsdb_id === currentId ? (
                  <span className="checkmark">✓</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
    }
    