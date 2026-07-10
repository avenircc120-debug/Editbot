// Messages Telegram pré-formatés — Editbot (assistant + dashboard, sans pronostics)

export function messageBienvenue(): string {
  return `👋 *Bienvenue sur Editbot !*

Je suis ton assistant foot. Discute avec moi librement pour tout savoir sur les matchs du jour (avant, pendant, après).

Pour aller plus loin :
🔗 /connect_facebook — relie ta Page Facebook pour diffuser automatiquement les scores en direct
📊 /dashboard — ouvre ton espace pour choisir tes compétitions et déposer tes codes coupons
❓ /aide — revoir cette aide`;
}

export function messageAide(): string {
  return `*Commandes disponibles*

/dashboard — ton espace (compétitions suivies + coupons)
/connect_facebook — connecter ta Page Facebook
/aide — cette aide

Sinon, écris-moi directement — je réponds à toutes tes questions sur les matchs du jour !`;
}

export function messageReveilMatinal(nbMatchs: number): string {
  return `Il y a des matchs aujourd'hui ! Préparez vos coupons ! ⚽ (${nbMatchs} match${nbMatchs > 1 ? 's' : ''} au programme)`;
}

export function formatScoreFacebook(data: {
  competition: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;
}): string {
  const statutLabel = data.status === 'finished' ? 'Match terminé' : 'En direct 🔴';
  return `⚽ ${statutLabel} — ${data.competition}

${data.homeTeam} ${data.homeScore} - ${data.awayScore} ${data.awayTeam}`;
}
