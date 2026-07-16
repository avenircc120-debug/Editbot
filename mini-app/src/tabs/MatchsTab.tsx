import { useState, useEffect, useCallback } from 'react';
import type { Match, Profile, FBPage } from '@/api';
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

// ── Sélecteur de pages Facebook ───────────────────────────────────────────────

interface PagePickerProps {
  pages: FBPage[];
  onConfirm: (pageIds: string[]) => void;
  onCancel: () => void;
}

function PagePicker({ pages, onConfirm, onCancel }: PagePickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(pages.map(p => p.fb_page_id)));

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
        width: '100%', maxWidth: 480, padding: '20px 16px 28px',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: 'var(--text, #fff)' }}>
          📘 Sur quelle(s) page(s) diffuser ?
        </div>
        {pages.map(page => (
          <label key={page.fb_page_id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 4px', cursor: 'pointer',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            color: 'var(--text, #fff)',
          }}>
            <input
              type="checkbox"
              checked={selected.has(page.fb_page_id)}
              onChange={() => toggle(page.fb_page_id)}
              style={{ width: 18, height: 18, accentColor: 'var(--green, #30d158)', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 14 }}>{page.fb_page_name}</span>
          </label>
        ))}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
            background: 'rgba(255,255,255,0.1)', color: 'var(--text, #fff)',
            fontSize: 14, cursor: 'pointer',
          }}>Annuler</button>
          <button
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
            style={{
              flex: 2, padding: '11px 0', borderRadius: 10, border: 'none',
              background: selected.size === 0 ? 'rgba(255,255,255,0.1)' : 'var(--green, #30d158)',
              color: selected.size === 0 ? 'rgba(255,255,255,0.4)' : '#000',
              fontSize: 14, fontWeight: 600, cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Diffuser {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Carte match ───────────────────────────────────────────────────────────────

interface MatchCardProps {
  match: Match;
  token: string;
  pages: FBPage[];
  onToggle: (matchId: string, active: boolean) => void;
}

function MatchCard({ match, token, pages, onToggle }: MatchCardProps) {
  const [busy, setBusy]           = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const isLive     = match.status === 'inprogress';
  const isFinished = match.status === 'finished';
  const showScore  = isLive || isFinished;

  async function doToggle(pageIds?: string[]) {
    const next = !match.isBroadcasting;
    onToggle(match.match_id, next);
    setBusy(true);
    try {
      await toggleBroadcast(token, match.match_id, next, {
        competition: match.competition,
        homeTeam:    match.home_team,
        awayTeam:    match.away_team,
        pageIds:     next ? (pageIds ?? []) : undefined,
      });
    } catch {
      onToggle(match.match_id, !next);
    } finally {
      setBusy(false);
    }
  }

  function handleToggle() {
    if (busy) return;
    const next = !match.isBroadcasting;
    // Activation + plusieurs pages → afficher le sélecteur
    if (next && pages.length > 1) {
      setShowPicker(true);
      return;
    }
    // Désactivation ou 1 seule page → direct
    doToggle(pages.length === 1 ? [pages[0].fb_page_id] : []);
  }

  function handlePickerConfirm(pageIds: string[]) {
    setShowPicker(false);
    doToggle(pageIds);
  }

  return (
    <>
      <div className={`match-card${isFinished ? ' finished' : ''}`}>
        {isLive && <div className="dot-live" />}
        <div className="match-info">
          {match.isBroadcasting && (
            <span style={{ fontSize: 11, color: 'var(--green)', marginBottom: 2, display: 'block' }}>
              📡 En diffusion
            </span>
          )}
          {showScore ? (
            <div className="match-score">
              {match.home_team}&nbsp;{match.home_score ?? '–'} — {match.away_score ?? '–'}&nbsp;{match.away_team}
            </div>
          ) : (
            <div className="match-teams">{match.home_team} vs {match.away_team}</div>
          )}
          <div className="match-time">{match.competition}</div>
        </div>
        <div className="match-right">
          {!isLive && !isFinished && (
            <div className="match-time" style={{ textAlign: 'right', marginBottom: 4, whiteSpace: 'nowrap', fontSize: 12 }}>
              {isToday(match.match_date) ? formatTime(match.match_date) : formatDate(match.match_date)}
            </div>
          )}
          {!isFinished && (
            <>
              <span className="broadcast-label">Diffuser</span>
              <button
                className={`toggle${match.isBroadcasting ? ' on' : ''}`}
                onClick={handleToggle}
                disabled={busy}
                aria-label="Activer/désactiver diffusion"
              />
            </>
          )}
        </div>
      </div>

      {showPicker && (
        <PagePicker
          pages={pages}
          onConfirm={handlePickerConfirm}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  );
}

// ── Tab principal ─────────────────────────────────────────────────────────────

interface Props { token: string; }

export default function MatchsTab({ token }: Props) {
  const [profile,       setProfile]       = useState<Profile | null>(null);
  const [matches,       setMatches]       = useState<Match[]>([]);
  const [filter,        setFilter]        = useState<Filter>('all');
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
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

  const pages    = profile?.fbPages ?? [];
  const live     = matches.filter(m => m.status === 'inprogress');
  const todayMtch = matches.filter(m => m.status === 'scheduled' && isToday(m.match_date) && isFuture(m.match_date));
  const upcoming = matches.filter(m => m.status === 'scheduled' && !isToday(m.match_date) && isFuture(m.match_date));
  const finished = matches.filter(m => m.status === 'finished');

  return (
    <>
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

      <div className="filter-pills">
        <button className={`pill${filter === 'all'   ? ' active' : ''}`} onClick={() => changeFilter('all')}>Tous</button>
        <button className={`pill${filter === 'live'  ? ' active' : ''}`} onClick={() => changeFilter('live')}>🔴 En direct</button>
        <button className={`pill${filter === 'today' ? ' active' : ''}`} onClick={() => changeFilter('today')}>📅 Aujourd'hui</button>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={() => loadData()}>Réessayer</button>
        </div>
      )}

      {loading && (
        <>
          <div className="shimmer" />
          <div className="shimmer" style={{ height: 56 }} />
          <div className="shimmer" />
        </>
      )}

      {!loading && !error && (
        <>
          {/* Avertissement si aucune page connectée */}
          {pages.length === 0 && (
            <div style={{
              background: 'rgba(255,159,10,0.12)', border: '1px solid rgba(255,159,10,0.3)',
              borderRadius: 10, padding: '10px 14px', marginBottom: 8,
              fontSize: 13, color: 'rgba(255,255,255,0.75)',
            }}>
              ⚠️ Connecte une Page Facebook pour activer la diffusion.
            </div>
          )}

          {live.length > 0 && filter !== 'today' && (
            <>
              <div className="section-header live">
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0, animation: 'pulse-live 1.5s infinite', display: 'inline-block' }} />
                En Direct
              </div>
              {live.map(m => <MatchCard key={m.match_id} match={m} token={token} pages={pages} onToggle={optimisticToggle} />)}
            </>
          )}

          {todayMtch.length > 0 && filter !== 'live' && (
            <>
              <div className="section-header">📅 À venir aujourd'hui</div>
              {todayMtch.map(m => <MatchCard key={m.match_id} match={m} token={token} pages={pages} onToggle={optimisticToggle} />)}
            </>
          )}

          {upcoming.length > 0 && filter !== 'live' && filter !== 'today' && (
            <>
              <div className="section-header">📆 Programme</div>
              {upcoming.map(m => <MatchCard key={m.match_id} match={m} token={token} pages={pages} onToggle={optimisticToggle} />)}
            </>
          )}

          {finished.length > 0 && filter !== 'live' && (
            <>
              <div className="section-header">⬛ Terminés</div>
              {finished.map(m => <MatchCard key={m.match_id} match={m} token={token} pages={pages} onToggle={optimisticToggle} />)}
            </>
          )}

          {live.length + todayMtch.length + upcoming.length + finished.length === 0 && (
            <div className="empty-state">
              <div className="emoji">⚽</div>
              <p>Aucun match trouvé pour cette compétition.</p>
            </div>
          )}
        </>
      )}

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
