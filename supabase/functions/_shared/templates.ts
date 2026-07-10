// Templates de messages Telegram pré-formatés

// Les utilisateurs ne connaissent pas le jargon des paris sportifs (BTTS, 1X2...).
// On affiche toujours un intitulé clair en français ; le nom technique reste entre
// parenthèses pour les habitués qui le reconnaissent.
const LABELS_PRONOSTIC: Record<string, string> = {
  '1X2':                 'Qui gagne le match',
  'BTTS':                'Les 2 équipes marquent',
  'Over/Under 2.5':      'Plus ou moins de 2.5 buts',
  'Double Chance':       'Double chance (2 résultats possibles sur 3)',
  'Score Exact':         'Score exact',
  'Corners Over/Under':  'Nombre de corners',
  'Mi-Temps 1X2':        'Qui mène à la mi-temps',
  'Cartons Over/Under':  'Nombre de cartons',
};

export function labelPronostic(type: string): string {
  return LABELS_PRONOSTIC[type] ?? type;
}

export function templatePronostic(data: {
  competition: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  pronosticType: string;
  pronosticValeur: string;
  fiabilite: number;
  coteConseille: number;
  analyseTexte: string;
}): string {
  const emoji = data.fiabilite >= 80 ? '🟢' : data.fiabilite >= 65 ? '🟡' : '🔴';
  const warning = data.fiabilite < 70
    ? '\n⚠️ *Attention* : Fiabilité faible, risque élevé sur ce pari.'
    : '';

  return `📊 *PRONOSTIC — ${data.competition}*

⚽ *${data.homeTeam}* vs *${data.awayTeam}*
📅 ${formatDate(data.matchDate)}

━━━━━━━━━━━━━━━━━━
🎯 *Type* : ${labelPronostic(data.pronosticType)}
✅ *Pronostic* : \`${data.pronosticValeur}\`
💰 *Cote conseillée* : ${data.coteConseille}
${emoji} *Fiabilité* : ${data.fiabilite}%
━━━━━━━━━━━━━━━━━━

📝 *Analyse* :
${data.analyseTexte}
${warning}

_Pariez responsablement. Ce pronostic est basé sur des données statistiques._`;
}

export function templateListe(matchs: Array<{
  competition: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  pronosticValeur: string;
  fiabilite: number;
}>): string {
  if (matchs.length === 0) {
    return '📭 Aucun pronostic disponible pour le moment. Revenez plus tard !';
  }

  const lignes = matchs.map((m, i) => {
    const emoji = m.fiabilite >= 80 ? '🟢' : m.fiabilite >= 65 ? '🟡' : '🔴';
    return `${i + 1}. ${emoji} *${m.homeTeam}* vs *${m.awayTeam}*\n   🏆 ${m.competition} | 📅 ${formatDate(m.matchDate)}\n   ✅ ${m.pronosticValeur} (${m.fiabilite}%)`;
  }).join('\n\n');

  return `🗓️ *PRONOSTICS DU JOUR*\n\n${lignes}\n\n_Tapez /detail [numéro] pour l'analyse complète_`;
}

export function templateErreur(message: string): string {
  return `❌ *Erreur* : ${message}\n\nRéessayez ou contactez l'administrateur.`;
}

export function templateAide(): string {
  return `🤖 *Bot Pronostics Sportifs*

📌 *Commandes disponibles* :

/pronostics — Liste des pronostics du jour
/ligue1 — Matchs de Ligue 1
/pl — Matchs de Premier League
/ldc — Matchs de Champions League
/detail [id] — Analyse complète d'un match
/aide — Afficher cette aide

💡 *Types de paris* :
• Qui gagne le match (Victoire/Nul/Défaite)
• Score exact
• Les 2 équipes marquent
• Plus ou moins de 2.5 buts

⚠️ _Pariez responsablement. 18+ uniquement._`;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'
    });
  } catch {
    return dateStr;
  }
}
