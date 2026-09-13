// Templates de messages — Editbot (Live Scores)

/** Message de réveil matinal : liste des matchs du jour */
export function messageReveilMatinal(competition: string, matchs: Array<{ home_team: string; away_team: string; match_date: string }>): string {
  const lignes = matchs.map(m => {
    const heure = new Date(m.match_date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `⚽ ${m.home_team} vs ${m.away_team} — ${heure} UTC`;
  });
  return `📅 *${competition}* — Matchs d'aujourd'hui\n\n${lignes.join('\n')}\n\nLes scores seront publiés en direct sur ta Page Facebook dès le coup d'envoi.`;
}

/** Annonce immédiate quand l'utilisateur active la diffusion d'un match à venir.
 *  `standingsBlock` (optionnel) insère le classement de la compétition — voir
 *  formatStandingsBlock() — juste avant le message de clôture. Ce même post
 *  est ensuite édité en place par facebook-post dès le coup d'envoi (voir
 *  editerPost dans _shared/facebook.ts) : un seul post par match, qui passe
 *  de "annonce + classement" à "score en direct". */
export function formatAnnonceFacebook(data: { competition: string; homeTeam: string; awayTeam: string; matchDate: string; standingsBlock?: string }): string {
  const d     = new Date(data.matchDate);
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const jour  = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const tag   = data.competition.replace(/[\s\-()']/g, '');
  let msg = `📣 ${data.competition}\n\n⚽ ${data.homeTeam}  vs  ${data.awayTeam}\n🗓 ${jour.charAt(0).toUpperCase() + jour.slice(1)} à ${heure} UTC\n\n`;
  if (data.standingsBlock) msg += `${data.standingsBlock}\n\n`;
  msg += `Restez connectés — scores et actions en direct sur cette page dès le coup d'envoi !\n\n#Football #${tag}`;
  return msg;
}

/**
 * Classement d'une compétition, formaté pour un post Facebook — les deux
 * équipes du match sont préfixées par ▶ pour ressortir dans la liste. Les
 * noms d'équipes viennent tous deux d'ESPN (standings et matchs_index), donc
 * une comparaison exacte suffit — pas besoin de normaliser les accents/sigles.
 */
export function formatStandingsBlock(
  entries: Array<{ team: string; rank: number | null; points: number | null; wins: number | null; draws: number | null; losses: number | null }>,
  matchTeams: string[] = [],
  limit = 5,
): string {
  const classement = entries
    .filter((e) => e.rank != null)
    .sort((a, b) => (a.rank as number) - (b.rank as number));
  if (!classement.length) return '';

  const top = classement.slice(0, limit);
  // Une des deux équipes du match peut être hors du top N (ex: équipe reléguée
  // qui joue contre le leader) — sans ça elle disparaîtrait complètement du
  // classement envoyé, ce qui n'a pas de sens pour l'annonce D'UN MATCH précis.
  const topIds = new Set(top.map((e) => e.team));
  const manquantes = classement.filter((e) => matchTeams.includes(e.team) && !topIds.has(e.team));
  const classes = [...top, ...manquantes];

  // Format compact (sans V/N/D) pour rester le plus court possible — Facebook
  // tronque tout post de plus de quelques lignes avec "Voir plus" dans le fil
  // (comportement de l'appli, pas quelque chose que l'API peut désactiver) ;
  // ceci ne l'évite pas totalement mais réduit la longueur au maximum.
  const lignes = classes.map((e) => {
    const marque = matchTeams.includes(e.team) ? '▶ ' : '';
    const pts    = e.points != null ? `${e.points} pts` : '';
    return `${marque}${e.rank}. ${e.team} — ${pts}`;
  });
  return `📊 Classement :\n${lignes.join('\n')}`;
}

// ─── Post cumulatif avec timeline des événements ────────────────────────────

export interface ButeurDetail { nom: string; espnId: string | null; }

/** Parse le format "Nom|idEspn;Nom2|idEspn2" produit par buteursEquipe()
 *  (_shared/espn.ts) — l'id est absent (chaîne vide côté ESPN, ou champ
 *  manquant côté TheSportsDB qui ne fournit pas cette donnée) auquel cas
 *  espnId vaut null plutôt qu'une chaîne vide, pour que l'appelant puisse
 *  simplement tester sa présence. */
export function parseGoalDetails(raw: string | null | undefined): ButeurDetail[] {
  return (raw ?? '').split(';').map(s => s.trim()).filter(Boolean).map(entree => {
    const [nom, espnId] = entree.split('|');
    return { nom: (nom ?? '').trim(), espnId: espnId?.trim() || null };
  });
}

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
  const homeGoals = parseGoalDetails(homeGoalDetails);
  const awayGoals = parseGoalDetails(awayGoalDetails);
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
      const scorer = homeGoals[homeIdx++]?.nom || null;
      lines.push(scorer ? `⚽ ${scorer} (${homeTeam})` : `⚽ But ! (${homeTeam})`);
    } else if (marker === 'GOAL_AWAY') {
      const scorer = awayGoals[awayIdx++]?.nom || null;
      lines.push(scorer ? `⚽ ${scorer} (${awayTeam})` : `⚽ But ! (${awayTeam})`);
    }
  }

  return lines.join('\n');
}

/**
 * Légende du post photo publié séparément quand un but est marqué (voir
 * posterPhotoSurPage dans _shared/facebook.ts, appelé depuis facebook-post
 * uniquement quand ESPN fournit un id de joueur exploitable via
 * espnHeadshotUrl). Reste court : la photo est le contenu principal.
 */
export function buildGoalPhotoCaption(data: {
  scorerName: string;
  scoringTeam: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  competition: string;
}): string {
  const tag = data.competition.replace(/[\s\-()']/g, '');
  return `⚽ BUT ! ${data.scorerName} (${data.scoringTeam})\n\n`
    + `${data.homeTeam}  ${data.homeScore} - ${data.awayScore}  ${data.awayTeam}\n`
    + `${data.competition}\n\n#Football #${tag}`;
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
  /** Chrono du match tel qu'affiché par ESPN (ex: "34'", "45+2'") — affiché
   *  dans l'en-tête et mis à jour à chaque cycle live-cron, même sans but. */
  liveClock?:       string | null;
}): string {
  const { competition, homeTeam, awayTeam, status, eventType, eventsLog, liveClock } = data;
  const hs  = data.homeScore ?? 0;
  const as_ = data.awayScore ?? 0;
  const tag = competition.replace(/[\s\-()']/g, '');

  // ── En-tête ───────────────────────────────────────────────────────────
  let header: string;
  if (eventType === 'halftime') {
    header = '⏸ Mi-temps';
  } else if (eventType === 'fulltime' || status === 'finished') {
    header = '🏁 Résultat final';
  } else if (eventType === 'goal') {
    header = liveClock ? `🔴 En direct ${liveClock} ⚽` : '🔴 En direct ⚽';
  } else {
    header = liveClock ? `🔴 En direct ${liveClock}` : '🔴 En direct';
  }

  // ── Corps principal ───────────────────────────────────────────────────────
  let msg = `${header} — ${competition}\n\n`;
  msg    += `${homeTeam}  ${hs} - ${as_}  ${awayTeam}`;

  // ── Timeline des événements ───────────────────────────────────────────────
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

  // ── Conclusion fin de match ─────────────────────────────────────────────────
  if (eventType === 'fulltime' || status === 'finished') {
    if (hs > as_)      msg += `\n\n🏆 Victoire ${homeTeam} !`;
    else if (as_ > hs) msg += `\n\n🏆 Victoire ${awayTeam} !`;
    else               msg += '\n\n🤝 Match nul !';
  }

  msg += `\n\n#Football #${tag}`;
  return msg;
}
