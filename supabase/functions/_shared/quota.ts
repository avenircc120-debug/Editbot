/**
 * Quota journalier — protection des APIs gratuites
 * APIs gérées : thesportsdb | groq | rapidapi | apifootball | sofascore | odds
 * (le type ci-dessous doit rester aligné avec les cases gérées par la fonction
 * SQL quota_consommer() — voir migration correspondante).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Api = 'thesportsdb' | 'groq' | 'rapidapi' | 'apifootball' | 'sofascore' | 'odds';

export async function consommerQuota(supabase: SupabaseClient, api: Api): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) {
    console.warn(`[quota] Erreur RPC quota_consommer(${api}):`, error.message);
    return true; // fail-open
  }
  if (!data) {
    console.warn(`[quota] 🛑 Quota ${api} épuisé pour aujourd'hui`);
  }
  return Boolean(data);
}

export async function lireQuotas(
  supabase: SupabaseClient,
): Promise<Record<string, { compteur: number; limite: number; reste: number }>> {
  const { data } = await supabase
    .from('quota_journalier')
    .select('api, compteur, limite')
    .eq('date', new Date().toISOString().slice(0, 10));

  const result: any = {};
  for (const row of data ?? []) {
    result[row.api] = {
      compteur: row.compteur,
      limite:   row.limite,
      reste:    row.limite - row.compteur,
    };
  }
  return result;
}
