// _shared/sa-auth.ts — DÉSACTIVÉ (Service Account non disponible)
// Les fonctions utilisent maintenant des API keys Google + Supabase DB.
// Ce fichier est conservé pour éviter les erreurs d'import si d'anciennes
// fonctions le référencent encore.

export async function getAccessToken(_scopes: string[]): Promise<string> {
  throw new Error(
    "Service Account non configuré. Utilisez les API keys Google à la place."
  );
}
