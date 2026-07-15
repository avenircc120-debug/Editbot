// Templates de messages — Editbot (Live Scores)

    /** Message de réveil matinal : liste des matchs du jour */
    export function messageReveilMatinal(competition: string, matchs: Array<{ home_team: string; away_team: string; match_date: string }>): string {
    const lignes = matchs.map(m => {
      const heure = new Date(m.match_date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      return `⚽ ${m.home_team} vs ${m.away_team} — ${heure} UTC`;
    });
    return `📅 *${competition}* — Matchs d'aujourd'hui\n\n${lignes.join('\n')}\n\nLes scores seront publiés en direct sur ta Page Facebook dès le coup d'envoi.`;
    }

    /** Annonce immédiate quand l'utilisateur active la diffusion d'un match à venir */
    export function formatAnnonceFacebook(data: { competition: string; homeTeam: string; awayTeam: string; matchDate: string }): string {
    const d     = new Date(data.matchDate);
    const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const jour  = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const tag   = data.competition.replace(/[\s\-()]/g, '');
    return `📣 ${data.competition}

    ⚽ ${data.homeTeam}  vs  ${data.awayTeam}
    🗓 ${jour.charAt(0).toUpperCase() + jour.slice(1)} à ${heure} UTC

    Restez connectés — scores et actions en direct sur cette page dès le coup d'envoi !

    #Football #${tag} #LiveScore`;
    }

    /** Post Facebook pour un score en direct ou terminé, avec buteurs et minute */
    export function formatScoreFacebook(data: {
    competition: string; homeTeam: string; awayTeam: string;
    homeScore: number; awayScore: number; status: string;
    homeGoalDetails?: string | null; awayGoalDetails?: string | null; minute?: number | null;
    }): string {
    const live        = data.status !== 'finished';
    const minStr      = live && data.minute ? ` ${data.minute}'` : '';
    const statutLabel = data.status === 'finished' ? '⬛ Match terminé' : `🔴 En direct${minStr}`;
    const tag         = data.competition.replace(/[\s\-()]/g, '');
    let msg = `${statutLabel} — ${data.competition}\n\n${data.homeTeam}  ${data.homeScore ?? 0} - ${data.awayScore ?? 0}  ${data.awayTeam}\n`;
    if (data.homeGoalDetails) data.homeGoalDetails.split(';').map((s:string) => s.trim()).filter(Boolean).forEach((b:string) => { msg += `⚽ ${b} (${data.homeTeam})\n`; });
    if (data.awayGoalDetails) data.awayGoalDetails.split(';').map((s:string) => s.trim()).filter(Boolean).forEach((b:string) => { msg += `⚽ ${b} (${data.awayTeam})\n`; });
    return msg + `\n#Football #${tag}`;
    }
    