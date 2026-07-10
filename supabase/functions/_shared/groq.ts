/**
 * Assistant conversationnel Groq — Editbot
 *
 * Remplace l'ancien moteur de génération de pronostics. Ce module ne fait
 * plus AUCUN calcul de probabilité / cote : il alimente une conversation
 * naturelle avec l'utilisateur, à partir des données réelles des matchs du
 * jour (fournies par l'appelant) et de l'historique de conversation.
 */

import { GROQ, SYSTEM_PROMPT } from './config.ts';

const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? '';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Envoie une conversation à Groq et renvoie la réponse texte de l'assistant.
 * @param history   Historique de conversation (sans le system prompt)
 * @param contexte  Contexte factuel à injecter (ex: liste des matchs du jour)
 */
export async function chatAssistant(history: ChatMessage[], contexte?: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: contexte ? `${SYSTEM_PROMPT}\n\nDONNÉES RÉELLES DISPONIBLES:\n${contexte}` : SYSTEM_PROMPT },
    ...history,
  ];

  const res = await fetch(`${GROQ.BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ.MODEL,
      max_tokens:  GROQ.MAX_TOKENS,
      temperature: 0.7,
      messages,
    }),
  });

  if (!res.ok) {
    console.error('[groq] HTTP', res.status, await res.text());
    return "Désolé, je rencontre un souci technique. Réessaie dans un instant.";
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "Désolé, je n'ai pas compris.";
}
