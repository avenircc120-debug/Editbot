import { CONFIG, SYSTEM_PROMPT } from './config.ts';

const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? '';

export interface PronosticResult {
  pronostic_type: string;
  pronostic_valeur: string;
  fiabilite: number;
  cote_conseille: number;
  analyse_texte: string;
  tokens_utilises: number;
}

export async function analyserMatch(
  homeTeam: string,
  awayTeam: string,
  competition: string,
  matchDate: string,
  homeForm: string[],
  awayForm: string[],
  h2h: any[],
  pronosticType: string
): Promise<PronosticResult> {
  const statsResume = buildStatsResume(homeTeam, awayTeam, homeForm, awayForm, h2h);

  const userPrompt = `Analyse ce match et génère un pronostic de type "${pronosticType}".

Match : ${homeTeam} vs ${awayTeam}
Compétition : ${competition}
Date : ${matchDate}

${statsResume}

Réponds UNIQUEMENT avec ce JSON (sans markdown) :
{
  "pronostic_valeur": "...",
  "fiabilite": 75,
  "cote_conseille": 1.85,
  "analyse": "Ton analyse argumentée en 3-4 phrases max"
}`;

  const res = await fetch(`${CONFIG.GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: CONFIG.MAX_TOKENS_GROQ,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status}`);
  const data = await res.json();
  const content = data.choices[0]?.message?.content ?? '{}';
  const tokens = data.usage?.total_tokens ?? 0;
  const parsed = JSON.parse(content);

  return {
    pronostic_type: pronosticType,
    pronostic_valeur: parsed.pronostic_valeur ?? 'N/A',
    fiabilite: Math.min(100, Math.max(0, parsed.fiabilite ?? 50)),
    cote_conseille: parsed.cote_conseille ?? 1.0,
    analyse_texte: parsed.analyse ?? '',
    tokens_utilises: tokens,
  };
}

function buildStatsResume(
  homeTeam: string,
  awayTeam: string,
  homeForm: string[],
  awayForm: string[],
  h2h: any[]
): string {
  const homeFormStr = homeForm.length ? homeForm.join('-') : 'N/D';
  const awayFormStr = awayForm.length ? awayForm.join('-') : 'N/D';

  let h2hResume = 'Pas de données H2H disponibles';
  if (h2h && h2h.length > 0) {
    const homeWins = h2h.filter((m: any) => {
      const isHome = m.homeTeam?.name === homeTeam;
      const hw = m.homeScore?.current ?? 0;
      const aw = m.awayScore?.current ?? 0;
      return isHome ? hw > aw : aw > hw;
    }).length;
    const awayWins = h2h.filter((m: any) => {
      const isHome = m.homeTeam?.name === homeTeam;
      const hw = m.homeScore?.current ?? 0;
      const aw = m.awayScore?.current ?? 0;
      return isHome ? aw > hw : hw > aw;
    }).length;
    const draws = h2h.length - homeWins - awayWins;
    h2hResume = `Sur ${h2h.length} derniers confrontations: ${homeTeam} ${homeWins}V / ${draws}N / ${awayWins}D`;
  }

  return `DONNÉES STATISTIQUES:
- Forme récente ${homeTeam} (dom): ${homeFormStr}
- Forme récente ${awayTeam} (ext): ${awayFormStr}
- Historique H2H: ${h2hResume}`;
}
