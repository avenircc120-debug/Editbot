/**
 * Quota journalier — protection des APIs gratuites
 * APIs gérées : thesportsdb | apifootball | groq | rapidapi (legacy)
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Api = 'thesportsdb' | 'apifootball' | 'groq' | 'rapidapi' | 'odds';

/**
 * Tente de consommer 1 unité de quota pour l'API donnée.
 * Mode fail-open : en cas d'erreur DB, autorise l'appel (usage interne tolérant).
 * Préférer consommerQuotaStrict pour les APIs à budget serré.
 */
export async function consommerQuota(supabase: SupabaseClient, api: Api): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) {
    console.warn(`[quota] Erreur RPC quota_consommer(${api}):`, error.message);
    return true; // fail-open : laisse passer plutôt que de bloquer
  }
  if (!data) {
    console.warn(`[quota] 🛑 Quota ${api} épuisé pour aujourd'hui`);
  }
  return Boolean(data);
}

/**
 * Variante fail-closed : en cas d'erreur DB, bloque l'appel.
 * À utiliser pour les APIs avec un budget journalier strict (ex: apifootball 80/j).
 */
export async function consommerQuotaStrict(supabase: SupabaseClient, api: Api): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) {
    console.warn(`[quota] Erreur RPC quota_consommer(${api}) — appel bloqué (fail-closed):`, error.message);
    return false; // fail-closed : protège le budget en cas d'incident DB
  }
  if (!data) {
    console.warn(`[quota] 🛑 Quota ${api} épuisé pour aujourd'hui`);
  }
  return Boolean(data);
}

/**
 * Retourne l'état actuel des quotas (pour les logs et le rapport).
 */
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

/**
 * Wrapper autour d'un appel API externe avec vérification de quota.
 * Si le quota est épuisé, retourne null sans faire l'appel.
 */
export async function avecQuota<T>(
  supabase: SupabaseClient,
  api: Api,
  fn: () => Promise<T>,
): Promise<T | null> {
  const autorise = await consommerQuota(supabase, api);
  if (!autorise) return null;
  return fn();
}
