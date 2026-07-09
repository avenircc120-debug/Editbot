/**
 * Quota journalier — protection des APIs gratuites
 *
 * Utilise une fonction SQL atomique (quota_consommer) pour garantir
 * qu'aucune race condition ne dépasse la limite même sous parallélisme.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Api = 'rapidapi' | 'groq';

/**
 * Tente de consommer 1 unité de quota pour l'API donnée.
 * Retourne true si autorisé, false si quota épuisé.
 */
export async function consommerQuota(supabase: SupabaseClient, api: Api): Promise<boolean> {
  const { data, error } = await supabase.rpc('quota_consommer', { p_api: api });
  if (error) {
    console.warn(`[quota] Erreur RPC quota_consommer(${api}):`, error.message);
    return true; // En cas d'erreur DB, on laisse passer plutôt que de bloquer
  }
  if (!data) {
    console.warn(`[quota] 🛑 Quota ${api} épuisé pour aujourd'hui`);
  }
  return Boolean(data);
}

/**
 * Retourne l'état actuel des quotas (pour les logs et le rapport).
 */
export async function lireQuotas(supabase: SupabaseClient): Promise<Record<Api, { compteur: number; limite: number; reste: number }>> {
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
