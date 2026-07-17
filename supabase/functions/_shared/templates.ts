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
  const tag   = data.competition.replace(/[\s\-()']/g, '');
  return `📣 ${data.competition}

⚽ ${data.homeTeam}  vs  ${data.awayTeam}
🗓 ${jour.charAt(0).toUpperCase() + jour.slice(1)} à ${heure} UTC

Restez connectés — scores et actions en direct sur cette page dès le coup d'envoi !

#Football #${tag} #LiveScore`;
}

/**
 * Post Facebook pour un événement live : but, coup d'envoi, mi-temps ou fin de match.
 *
 * eventType :
 *   'goal'      → ⚽ BUT ! avec buteur(s)
 *   'kickoff'   → 🟢 Coup d'envoi !
 *   'halftime'  → ⏸ Mi-temps
 *   'fulltime'  → 🏁 Résultat final
 *   'update'    → 🔴 En direct (fallback)
 */
export function formatScoreFacebook(data: {
  competition:      string;
  homeTeam:         string;
  awayTeam:         string;
  homeScore:        number;
  awayScore:        number;
  status:           string;
  rawStatus?:       string | null;
  eventType?:       string | null;
  homeGoalDetails?: string | null;
  awayGoalDetails?: string | null;
  minute?:          number | null;
}): string {
  const tag      = data.competition.replace(/[\s\-()']/g, '');
  const hs       = data.homeScore ?? 0;
  const as_      = data.awayScore ?? 0;
  const minStr   = data.minute ? ` ${data.minute}'` : '';
  const rawSt    = (data.rawStatus ?? '').toUpperCase();
  const evType   = data.eventType ?? 'update';

  // ── En-tête selon le type d'événement ──────────────────────────────────────
  let header: string;
  if (evType === 'goal') {
    header = `⚽ BUT !${minStr}`;
  } else if (evType === 'kickoff') {
    header = '🟢 Coup d\'envoi !';
  } else if (evType === 'halftime') {
    header = '⏸ Mi-temps';
  } else if (evType === 'fulltime') {
    header = '🏁 Résultat final';
  } else if (rawSt === 'HT') {
    header = '⏸ Mi-temps';
  } else if (data.status === 'finished') {
    header = '🏁 Résultat final';
  } else {
    header = `🔴 En direct${minStr}`;
  }

  // ── Score ───────────────────────────────────────────────────────────────────
  let msg = `${header} — ${data.competition}\n\n`;
  msg    += `${data.homeTeam}  ${hs} - ${as_}  ${data.awayTeam}\n`;

  // ── Buteurs ─────────────────────────────────────────────────────────────────
  const parseButs = (details: string | null | undefined, team: string): string[] =>
    (details ?? '').split(';').map(s => s.trim()).filter(Boolean)
      .map(b => `⚽ ${b} (${team})`);

  const butsLocaux   = parseButs(data.homeGoalDetails, data.homeTeam);
  const butsVisiteur = parseButs(data.awayGoalDetails, data.awayTeam);

  if (butsLocaux.length || butsVisiteur.length) {
    msg += '\n';
    for (const b of [...butsLocaux, ...butsVisiteur].sort()) msg += b + '\n';
  }

  // ── Mi-temps / Fin : résumé ─────────────────────────────────────────────────
  if (evType === 'halftime') {
    msg += '\n⏱ Score à la mi-temps.';
  } else if (evType === 'fulltime') {
    if (hs > as_)       msg += `\n🏆 Victoire ${data.homeTeam} !`;
    else if (as_ > hs)  msg += `\n🏆 Victoire ${data.awayTeam} !`;
    else                msg += '\n🤝 Match nul !';
  }

  msg += `\n\n#Football #${tag}`;
  return msg;
}
