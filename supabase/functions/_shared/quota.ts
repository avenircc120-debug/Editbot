/**
 * Quota journalier — protection des APIs gratuites
 * APIs gérées : thesportsdb | sofascore | groq
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Api = 'thesportsdb' | 'sofascore' | 'groq';

/**
 * Tente de consommer 1 unité de quota pour l'API donnée.
 * Mode fail-open : en cas d'erreur DB, autorise l'appel (usage interne tolérant).
 */
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

/**
 * Variante fail-closed : en cas d'erreur DB, bloque l'appel.
 * À utiliser pour les APIs avec un budget journalier strict (ex: sofascore 15/j).
 */
export async function consommerQuotaStrict(supabase: SupabaseClient, api: Api): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) {
    console.warn(`[quota] Erreur RPC quota_consommer(${api}) — appel bloqué (fail-closed):`, error.message);
    return false;
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
