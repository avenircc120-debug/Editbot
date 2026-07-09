-- =============================================
-- Migration 004: Sources hybrides
-- TheSportsDB (calendrier / stats de base)
-- SofaScore via RapidAPI (H2H)
-- =============================================

-- Colonne de pont TheSportsDB
ALTER TABLE matchs_index
  ADD COLUMN IF NOT EXISTS id_thesportsdb TEXT;

-- Index sur l'ID TheSportsDB
CREATE INDEX IF NOT EXISTS idx_matchs_thesportsdb ON matchs_index(id_thesportsdb)
  WHERE id_thesportsdb IS NOT NULL;

-- Valeurs attendues dans marches_bruts.source :
--   'thesportsdb' | 'sofascore'

-- Ajout des nouvelles APIs dans le quota journalier
INSERT INTO quota_journalier (date, api, compteur, limite) VALUES
  -- TheSportsDB free : aucun rate limit documenté, on se fixe une limite haute
  (CURRENT_DATE, 'thesportsdb', 0, 500),
  -- SofaScore free tier RapidAPI : ~500 req/mois → 15/jour
  (CURRENT_DATE, 'sofascore', 0, 15)
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
      WHEN 'groq'         THEN 20
      WHEN 'thesportsdb'  THEN 500
      WHEN 'sofascore'    THEN 15
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
