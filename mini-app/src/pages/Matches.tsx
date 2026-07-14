import { useState, useEffect } from 'react';
import { getProfile, getMatches, toggleBroadcast, getFacebookPages, disconnectFacebookPage, Profile, Match, FBPage } from '@/api';
import { Loader2, Trash2 } from 'lucide-react';
import CompetitionModal from '@/components/CompetitionModal';
import { useToast } from '@/hooks/use-toast';

export default function Matches({ token }: { token: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [fbPages, setFbPages] = useState<FBPage[]>([]);
  const [activeFilter, setActiveFilter] = useState<'all' | 'live' | 'today'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [competitionModalOpen, setCompetitionModalOpen] = useState(false);
  const { toast } = useToast();

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const p = await getProfile(token);
      setProfile(p);
      
      const [m, fb] = await Promise.all([
        getMatches(token, p.competitionId, activeFilter),
        getFacebookPages(token)
      ]);
      setMatches(m);
      setFbPages(fb);
    } catch (err: any) {
      setError(err.message || 'Erreur lors du chargement des données');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [token, activeFilter]);

  const handleToggleBroadcast = async (match: Match) => {
    // Optimistic update
    const previousState = [...matches];
    setMatches(matches.map(m => m.match_id === match.match_id ? { ...m, isBroadcasting: !m.isBroadcasting } : m));
    
    try {
      await toggleBroadcast(token, match.match_id, !match.isBroadcasting, {
        competition: match.competition,
        homeTeam: match.home_team,
        awayTeam: match.away_team
      });
      toast({
        title: !match.isBroadcasting ? "Diffusion lancée" : "Diffusion arrêtée",
        description: `${match.home_team} vs ${match.away_team}`,
      });
    } catch (err) {
      // Revert on error
      setMatches(previousState);
      toast({
        title: "Erreur",
        description: "Impossible de modifier la diffusion.",
        variant: "destructive"
      });
    }
  };

  const handleDisconnectFb = async (page: FBPage) => {
    if (!window.confirm(`Déconnecter la page ${page.fb_page_name} ?`)) return;
    try {
      await disconnectFacebookPage(token, page.id);
      setFbPages(fbPages.filter(p => p.id !== page.id));
      toast({ title: "Page déconnectée" });
    } catch (err) {
      toast({ title: "Erreur de déconnexion", variant: "destructive" });
    }
  };

  if (loading && !profile) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-lg bg-card animate-pulse border border-border"></div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-lg bg-destructive/20 border border-destructive/50 p-4 text-center">
          <p className="text-destructive mb-2">{error}</p>
          <button onClick={loadData} className="px-4 py-2 bg-card rounded-md text-sm border border-border">Réessayer</button>
        </div>
      </div>
    );
  }

  const liveMatches = matches.filter(m => m.status === 'inprogress');
  const todayMatches = matches.filter(m => m.status === 'scheduled' && new Date(m.match_date).toDateString() === new Date().toDateString());
  const upcomingMatches = matches.filter(m => m.status === 'scheduled' && new Date(m.match_date).toDateString() !== new Date().toDateString());
  const finishedMatches = matches.filter(m => m.status === 'finished');

  return (
    <div className="flex flex-col w-full">
      {/* Competition Header */}
      <div className="sticky top-0 z-10 flex h-[52px] items-center justify-between bg-card px-4 border-b border-border shadow-sm">
        <div className="flex items-center gap-2 truncate">
          {profile?.competition ? (
            <span className="font-bold text-foreground truncate">{profile.competition}</span>
          ) : (
            <span className="text-muted-foreground text-sm">Aucune compétition</span>
          )}
        </div>
        <button 
          onClick={() => setCompetitionModalOpen(true)}
          className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground active:bg-accent/50"
        >
          Changer
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-3 hide-scrollbar">
        {[
          { id: 'all', label: 'Tous' },
          { id: 'live', label: '🔴 En direct' },
          { id: 'today', label: '📅 Aujourd\'hui' }
        ].map(filter => (
          <button
            key={filter.id}
            onClick={() => setActiveFilter(filter.id as any)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              activeFilter === filter.id 
                ? 'bg-primary text-primary-foreground' 
                : 'border border-border text-muted-foreground'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Match List */}
      <div className="flex-1 pb-4">
        {matches.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <span className="text-4xl mb-4 opacity-50 grayscale">⚽</span>
            <p className="text-muted-foreground">Aucun match trouvé pour cette compétition.</p>
          </div>
        )}

        {/* Live Matches */}
        {activeFilter !== 'today' && liveMatches.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 px-4 mb-2">
              <div className="h-2 w-2 rounded-full bg-destructive animate-pulse"></div>
              <h3 className="text-xs font-bold text-destructive uppercase tracking-wider">En direct</h3>
            </div>
            {liveMatches.map(match => (
              <div key={match.match_id} className="mx-3 my-1.5 flex items-center justify-between rounded-lg border border-border bg-card p-3 shadow-sm">
                <div className="flex-1 truncate pr-4">
                  <div className="flex items-center gap-2 mb-1">
                    {match.isBroadcasting && <span className="text-xs" title="Diffusion en cours">📡</span>}
                    <div className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse"></div>
                    <span className="text-xs text-muted-foreground truncate">{match.competition}</span>
                  </div>
                  <div className="font-bold text-foreground text-sm truncate">
                    {match.home_team} &nbsp; {match.home_score} — {match.away_score} &nbsp; {match.away_team}
                  </div>
                </div>
                <div className="flex flex-col items-center gap-1 shrink-0">
                  <span className="text-[9px] uppercase text-muted-foreground font-semibold tracking-wider">Diffuser</span>
                  <button 
                    onClick={() => handleToggleBroadcast(match)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${match.isBroadcasting ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${match.isBroadcasting ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Today's Matches */}
        {(activeFilter === 'all' || activeFilter === 'today') && todayMatches.length > 0 && (
          <div className="mb-6">
            <div className="px-4 mb-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">📅 Aujourd'hui</h3>
            </div>
            {todayMatches.map(match => (
              <div key={match.match_id} className="mx-3 my-1 flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div className="flex-1 truncate pr-2">
                  <div className="font-medium text-foreground text-sm truncate">
                    {match.home_team} vs {match.away_team}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {new Date(match.match_date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Upcoming */}
        {activeFilter === 'all' && upcomingMatches.length > 0 && (
          <div className="mb-6">
            <div className="px-4 mb-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">📆 Programme</h3>
            </div>
            {upcomingMatches.map(match => (
              <div key={match.match_id} className="mx-3 my-1 flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div className="flex-1 truncate">
                  <div className="text-xs text-muted-foreground mb-0.5">
                    {new Date(match.match_date).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit'})}
                  </div>
                  <div className="font-medium text-foreground text-sm truncate">
                    {match.home_team} vs {match.away_team}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Finished */}
        {finishedMatches.length > 0 && (
          <div className="mb-6 opacity-60">
            <div className="px-4 mb-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">✓ Terminés</h3>
            </div>
            {finishedMatches.map(match => (
              <div key={match.match_id} className="mx-3 my-1 flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div className="font-medium text-sm truncate">
                  {match.home_team} &nbsp; {match.home_score} — {match.away_score} &nbsp; {match.away_team}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Facebook Pages */}
      <div className="mt-auto border-t border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-foreground">Pages Facebook</h3>
          <span className="bg-muted text-muted-foreground text-[10px] px-2 py-0.5 rounded-full">{fbPages.length}</span>
        </div>
        
        {fbPages.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune page connectée</p>
        ) : (
          <div className="space-y-2">
            {fbPages.map(page => (
              <div key={page.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2 overflow-hidden">
                  <div className="h-6 w-6 shrink-0 rounded-full bg-[#1877F2] flex items-center justify-center text-white text-[10px] font-bold">f</div>
                  <div className="truncate">
                    <div className="text-sm text-foreground truncate">{page.fb_page_name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {page.last_post_at ? new Date(page.last_post_at).toLocaleDateString() : 'Jamais'}
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => handleDisconnectFb(page)}
                  className="shrink-0 text-[10px] text-destructive border border-destructive/30 rounded px-2 py-1 ml-2"
                >
                  Déconnecter
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {profile && (
        <CompetitionModal 
          open={competitionModalOpen} 
          onOpenChange={setCompetitionModalOpen}
          token={token}
          leagues={profile.leagues}
          currentId={profile.competitionId}
          onUpdated={loadData}
        />
      )}
    </div>
  );
}