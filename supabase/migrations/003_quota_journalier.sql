-- =============================================
-- Migration 003: Gestion du quota journalier
-- Protège les APIs gratuites (RapidAPI, Groq)
-- =============================================

CREATE TABLE IF NOT EXISTS quota_journalier (
  date      DATE    NOT NULL DEFAULT CURRENT_DATE,
  api       TEXT    NOT NULL,   -- 'rapidapi' | 'groq'
  compteur  INTEGER NOT NULL DEFAULT 0,
  limite    INTEGER NOT NULL,   -- seuil journalier configurable
  PRIMARY KEY (date, api)
);

-- Limites initiales conservatrices (plan gratuit)
-- RapidAPI SofaScore : ~500 req/mois → 15/jour
-- Groq               : 14 400 req/jour mais on se limite à 20 pour les tokens
INSERT INTO quota_journalier (date, api, compteur, limite) VALUES
  (CURRENT_DATE, 'rapidapi', 0, 15),
  (CURRENT_DATE, 'groq',     0, 20)
ON CONFLICT DO NOTHING;

-- Fonction atomique : incrémente et retourne true si sous la limite
CREATE OR REPLACE FUNCTION quota_consommer(p_api TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_limite  INTEGER;
  v_compteur INTEGER;
BEGIN
  -- Créer la ligne du jour si elle n'existe pas encore
  INSERT INTO quota_journalier (date, api, compteur, limite)
  VALUES (CURRENT_DATE, p_api,
    0,
    CASE p_api WHEN 'rapidapi' THEN 15 WHEN 'groq' THEN 20 ELSE 10 END
  )
  ON CONFLICT (date, api) DO NOTHING;

  -- Lire les valeurs courantes avec verrou
  SELECT compteur, limite INTO v_compteur, v_limite
  FROM quota_journalier
  WHERE date = CURRENT_DATE AND api = p_api
  FOR UPDATE;

  IF v_compteur >= v_limite THEN
    RETURN FALSE;  -- Quota épuisé
  END IF;

  UPDATE quota_journalier
  SET compteur = compteur + 1
  WHERE date = CURRENT_DATE AND api = p_api;

  RETURN TRUE;  -- Appel autorisé
END;
$$;
