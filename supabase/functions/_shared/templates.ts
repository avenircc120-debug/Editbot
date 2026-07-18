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

#Football #${tag}`;
}

// ─── Post cumulatif avec timeline des événements ────────────────────────────

/**
 * Convertit le journal structuré (marqueurs internes séparés par \n) en lignes
 * lisibles pour l'affichage Facebook.
 *
 * Marqueurs reconnus :
 *   KICKOFF
 *   GOAL_HOME   → utilise homeGoalDetails dans l'ordre
 *   GOAL_AWAY   → utilise awayGoalDetails dans l'ordre
 *   HALFTIME:hs:as
 *   FULLTIME
 */
function renderEventsLog(
  eventsLog: string,
  homeTeam: string,
  awayTeam: string,
  homeGoalDetails: string | null,
  awayGoalDetails: string | null,
): string {
  const homeGoals = (homeGoalDetails ?? '').split(';').map(s => s.trim()).filter(Boolean);
  const awayGoals = (awayGoalDetails ?? '').split(';').map(s => s.trim()).filter(Boolean);
  let homeIdx = 0;
  let awayIdx = 0;
  const lines: string[] = [];

  for (const marker of eventsLog.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (marker === 'KICKOFF') {
      lines.push('🟢 Coup d\'envoi');
    } else if (marker.startsWith('HALFTIME:')) {
      const parts = marker.split(':');
      lines.push(`⏸ Mi-temps : ${parts[1]}-${parts[2]}`);
    } else if (marker === 'FULLTIME') {
      lines.push('🏁 Résultat final');
    } else if (marker === 'GOAL_HOME') {
      const scorer = homeGoals[homeIdx++] ?? null;
      lines.push(scorer ? `⚽ ${scorer} (${homeTeam})` : `⚽ But ! (${homeTeam})`);
    } else if (marker === 'GOAL_AWAY') {
      const scorer = awayGoals[awayIdx++] ?? null;
      lines.push(scorer ? `⚽ ${scorer} (${awayTeam})` : `⚽ But ! (${awayTeam})`);
    }
  }

  return lines.join('\n');
}

/**
 * Calcule les nouveaux marqueurs à ajouter au journal selon l'événement reçu.
 *
 * Pour les buts : on compare le score actuel avec le nombre de buts déjà
 * enregistrés dans eventsLog afin de détecter combien de nouveaux buts
 * ont été marqués (et par quelle équipe).
 */
export function buildEventMarkers(data: {
  eventType: string | null | undefined;
  homeScore: number;
  awayScore: number;
  eventsLog: string;
}): string[] {
  const { eventType, homeScore, awayScore, eventsLog } = data;
  const markers: string[] = [];

  if (eventType === 'kickoff') {
    markers.push('KICKOFF');
  } else if (eventType === 'halftime') {
    markers.push(`HALFTIME:${homeScore}:${awayScore}`);
  } else if (eventType === 'fulltime') {
    markers.push('FULLTIME');
  } else if (eventType === 'goal') {
    const prevHome = (eventsLog.match(/^GOAL_HOME$/gm) ?? []).length;
    const prevAway = (eventsLog.match(/^GOAL_AWAY$/gm) ?? []).length;
    const newHome  = Math.max(0, homeScore - prevHome);
    const newAway  = Math.max(0, awayScore - prevAway);
    for (let i = 0; i < newHome; i++) markers.push('GOAL_HOME');
    for (let i = 0; i < newAway; i++) markers.push('GOAL_AWAY');
  }

  return markers;
}

/**
 * Construit le texte complet du post Facebook à partir du journal accumulé.
 *
 * Format final :
 *   🔴 En direct — Compétition           (ou ⏸ / 🏁)
 *
 *   Équipe A  2 - 1  Équipe B
 *
 *   ―――――――――――――――
 *   🟢 Coup d'envoi
 *   ⚽ Éverton Ribeiro 23' (Bahia)
 *   ⏸ Mi-temps : 1-0
 *   ⚽ Gabriel Barbosa 67' (Bahia)
 *   🏁 Résultat final
 *
 *   🏆 Victoire Bahia !
 *
 *   #Football #BrazilianSerieA
 */
export function buildFacebookPost(data: {
  competition:      string;
  homeTeam:         string;
  awayTeam:         string;
  homeScore:        number;
  awayScore:        number;
  status:           string;
  eventType?:       string | null;
  eventsLog:        string;
  homeGoalDetails?: string | null;
  awayGoalDetails?: string | null;
}): string {
  const { competition, homeTeam, awayTeam, status, eventType, eventsLog } = data;
  const hs  = data.homeScore ?? 0;
  const as_ = data.awayScore ?? 0;
  const tag = competition.replace(/[\s\-()']/g, '');

  // ── En-tête ────────────────────────────────────────────────────────────────
  let header: string;
  if (eventType === 'halftime') {
    header = '⏸ Mi-temps';
  } else if (eventType === 'fulltime' || status === 'finished') {
    header = '🏁 Résultat final';
  } else if (eventType === 'goal') {
    header = '🔴 En direct ⚽';
  } else {
    header = '🔴 En direct';
  }

  // ── Corps principal ────────────────────────────────────────────────────────
  let msg = `${header} — ${competition}\n\n`;
  msg    += `${homeTeam}  ${hs} - ${as_}  ${awayTeam}`;

  // ── Timeline des événements ────────────────────────────────────────────────
  if (eventsLog) {
    const rendered = renderEventsLog(
      eventsLog, homeTeam, awayTeam,
      data.homeGoalDetails ?? null,
      data.awayGoalDetails ?? null,
    );
    if (rendered) {
      msg += '\n\n―――――――――――――――\n' + rendered;
    }
  }

  // ── Conclusion fin de match ────────────────────────────────────────────────
  if (eventType === 'fulltime' || status === 'finished') {
    if (hs > as_)      msg += `\n\n🏆 Victoire ${homeTeam} !`;
    else if (as_ > hs) msg += `\n\n🏆 Victoire ${awayTeam} !`;
    else               msg += '\n\n🤝 Match nul !';
  }

  msg += `\n\n#Football #${tag}`;
  return msg;
}
