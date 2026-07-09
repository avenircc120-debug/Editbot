-- =============================================
-- Migration 004: Sources hybrides
-- TheSportsDB (calendrier / stats de base)
-- api-football (stats détaillées via RapidAPI)
-- =============================================

-- Pont entre TheSportsDB et api-football
ALTER TABLE matchs_index
  ADD COLUMN IF NOT EXISTS id_apifootball TEXT,
  ADD COLUMN IF NOT EXISTS id_thesportsdb TEXT;

-- Index sur les IDs de pont
CREATE INDEX IF NOT EXISTS idx_matchs_apifootball ON matchs_index(id_apifootball)
  WHERE id_apifootball IS NOT NULL;

-- Mettre à jour la colonne source de marches_bruts
-- (déjà TEXT, rien à changer structurellement — on ajoute juste les nouvelles valeurs)
-- Valeurs attendues : 'thesportsdb' | 'apifootball' | 'sofascore' (legacy)

-- Ajout des nouvelles APIs dans le quota journalier
INSERT INTO quota_journalier (date, api, compteur, limite) VALUES
  -- TheSportsDB free : aucun rate limit documenté, on se fixe une limite haute
  (CURRENT_DATE, 'thesportsdb', 0, 500),
  -- api-football free tier : 100 req/jour, on garde une marge de sécurité
  (CURRENT_DATE, 'apifootball', 0, 80)
ON CONFLICT DO NOTHING;

-- Mettre à jour la fonction quota_consommer pour les nouvelles clés
CREATE OR REPLACE FUNCTION quota_consommer(p_api TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_limite   INTEGER;
  v_compteur INTEGER;
BEGIN
  INSERT INTO quota_journalier (date, api, compteur, limite)
  VALUES (
    CURRENT_DATE,
    p_api,
    0,
    CASE p_api
      WHEN 'rapidapi'     THEN 15
      WHEN 'groq'         THEN 20
      WHEN 'thesportsdb'  THEN 500
      WHEN 'apifootball'  THEN 80
      ELSE 10
    END
  )
  ON CONFLICT (date, api) DO NOTHING;

  SELECT compteur, limite INTO v_compteur, v_limite
  FROM quota_journalier
  WHERE date = CURRENT_DATE AND api = p_api
  FOR UPDATE;

  IF v_compteur >= v_limite THEN
    RETURN FALSE;
  END IF;

  UPDATE quota_journalier
  SET compteur = compteur + 1
  WHERE date = CURRENT_DATE AND api = p_api;

  RETURN TRUE;
END;
$$;
