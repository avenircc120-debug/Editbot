// Templates de messages — Editbot (Live Scores)

/** Message de réveil matinal : liste des matchs du jour pour une compétition */
export function messageReveilMatinal(competition: string, matchs: Array<{ home_team: string; away_team: string; match_date: string }>): string {
  const lignes = matchs.map(m => {
    const heure = new Date(m.match_date).toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    });
    return `⚽ ${m.home_team} vs ${m.away_team} — ${heure} UTC`;
  });

  return `📅 *${competition}* — Matchs d'aujourd'hui\n\n${lignes.join('\n')}\n\nLes scores seront publiés en direct sur ta Page Facebook dès le coup d'envoi.`;
}

/** Post Facebook pour un score en direct ou terminé */
export function formatScoreFacebook(data: {
  competition: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;
}): string {
  const statutLabel = data.status === 'finished' ? '⬛ Match terminé' : '🔴 En direct';
  return `${statutLabel} — ${data.competition}

${data.homeTeam} ${data.homeScore} - ${data.awayScore} ${data.awayTeam}

#Football #${data.competition.replace(/\s/g, '')}`;
}
