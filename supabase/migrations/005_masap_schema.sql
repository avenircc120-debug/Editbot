-- =============================================
-- Migration 005 — MASAP : Architecture marchés bookmakers
-- Tables maîtresses pour l'analyse multi-marchés complète
-- =============================================

-- ─── 1. historique_performances ──────────────────────────────────────────────
-- Table enrichie qui remplace matchs_historique pour le module MASAP
-- Stocke le score final + toutes les stats dans un JSONB flexible
CREATE TABLE IF NOT EXISTS historique_performances (
  id                  BIGSERIAL PRIMARY KEY,
  match_id            TEXT UNIQUE NOT NULL,      -- ID pivot (TheSportsDB event ID)
  date                TIMESTAMPTZ NOT NULL,
  competition         TEXT NOT NULL,
  equipe_domicile     TEXT NOT NULL,
  equipe_exterieur    TEXT NOT NULL,
  score_final         TEXT,                      -- Ex: "2-1", null si à venir
  -- JSONB libre : possession, tirs, xG, corners, cartons, passes, etc.
  stats_json          JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 2. marches_bookmakers (table maîtresse) ─────────────────────────────────
-- Une ligne par (match × bookmaker). JSONB contient TOUS les marchés disponibles,
-- normalisés par le module market-mapper en clés standardisées.
CREATE TABLE IF NOT EXISTS marches_bookmakers (
  id                  BIGSERIAL PRIMARY KEY,
  match_id            TEXT NOT NULL,
  nom_bookmaker       TEXT NOT NULL,
  bookmaker_id        INTEGER,

  -- ─── Structure de marche_donnees ────────────────────────────────────────
  -- {
  --   "meta": { "source", "fetch_at", "fixture_apif_id" },
  --   "marches": {
  --     "1x2":          { "domicile": 1.55, "nul": 3.80, "exterieur": 5.50 },
  --     "btts":         { "oui": 1.72, "non": 2.05 },
  --     "double_chance":{ "1X": 1.14, "X2": 2.50, "12": 1.28 },
  --     "over_under":   { "0.5": {"over":1.05,"under":9.00}, "2.5": {"over":1.90,"under":1.90} },
  --     "corners":      { "8.5": {"over":1.90,"under":1.90}, "9.5": {"over":2.20,"under":1.70} },
  --     "cartons":      { "3.5": {"over":1.85,"under":1.95}, "4.5": {"over":2.80,"under":1.45} },
  --     "score_exact":  { "1-0": 7.50, "2-1": 9.00, "0-0": 9.50 },
  --     "mi_temps":     { "domicile": 2.20, "nul": 2.30, "exterieur": 5.50 },
  --     "handicap":     { "-1.0": {"domicile":1.90,"exterieur":1.90} },
  --     "mi_temps_ft":  { "1/1": 3.20, "1/X": 8.00, "X/2": 6.00 }
  --   }
  -- }
  marche_donnees      JSONB DEFAULT '{}' NOT NULL,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_marches_match_book UNIQUE (match_id, nom_bookmaker)
);

-- ─── 3. analyse_confrontation ────────────────────────────────────────────────
-- Données H2H + moyennes statistiques calculées pour chaque match,
-- alimentées par fetch-matches puis utilisées par analyse-matches.
CREATE TABLE IF NOT EXISTS analyse_confrontation (
  id                      BIGSERIAL PRIMARY KEY,
  match_id                TEXT UNIQUE NOT NULL,

  -- Moyennes sur les N derniers matchs à domicile (buts, corners, cartons, etc.)
  moyenne_domicile_json   JSONB DEFAULT '{}',
  -- Idem pour l'équipe extérieure
  moyenne_exterieur_json  JSONB DEFAULT '{}',
  -- Comparaison structurée : avantage/désavantage par catégorie
  comparaison_resultat    JSONB DEFAULT '{}',

  -- Score de confiance global calculé par l'IA (0-100)
  confiance_score         INTEGER CHECK (confiance_score BETWEEN 0 AND 100),

  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 4. whitelist_matchs ─────────────────────────────────────────────────────
-- Matchs prioritaires pour la mise à jour sélective des cotes toutes les 10 min
CREATE TABLE IF NOT EXISTS whitelist_matchs (
  id                      BIGSERIAL PRIMARY KEY,
  match_id                TEXT UNIQUE NOT NULL,
  fixture_apif_id         INTEGER,               -- ID api-football pour /odds
  competition             TEXT NOT NULL,
  equipe_domicile         TEXT NOT NULL,
  equipe_exterieur        TEXT NOT NULL,
  match_date              TIMESTAMPTZ NOT NULL,
  actif                   BOOLEAN DEFAULT TRUE,
  intervalle_refresh_min  INTEGER DEFAULT 10,    -- fréquence de refresh en minutes
  dernier_refresh         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 5. Index ─────────────────────────────────────────────────────────────────

-- historique_performances
CREATE INDEX IF NOT EXISTS idx_hp_match_id   ON historique_performances(match_id);
CREATE INDEX IF NOT EXISTS idx_hp_date       ON historique_performances(date);
CREATE INDEX IF NOT EXISTS idx_hp_stats_gin  ON historique_performances USING GIN (stats_json);

-- marches_bookmakers — GIN pour requêtes complexes sur cotes
-- Permet: WHERE (marche_donnees->'marches'->'corners'->'8.5'->>'over')::numeric > 2.0
CREATE INDEX IF NOT EXISTS idx_mb_match_id   ON marches_bookmakers(match_id);
CREATE INDEX IF NOT EXISTS idx_mb_bookmaker  ON marches_bookmakers(nom_bookmaker);
CREATE INDEX IF NOT EXISTS idx_mb_donnees_gin ON marches_bookmakers USING GIN (marche_donnees);
-- Index expression sur la clé 1x2 domicile (marché le plus requêté)
CREATE INDEX IF NOT EXISTS idx_mb_cote_dom
  ON marches_bookmakers (((marche_donnees->'marches'->'1x2'->>'domicile')::numeric))
  WHERE marche_donnees->'marches'->'1x2' IS NOT NULL;

-- analyse_confrontation
CREATE INDEX IF NOT EXISTS idx_ac_match_id   ON analyse_confrontation(match_id);
CREATE INDEX IF NOT EXISTS idx_ac_confiance  ON analyse_confrontation(confiance_score);

-- whitelist_matchs
CREATE INDEX IF NOT EXISTS idx_wl_actif      ON whitelist_matchs(actif) WHERE actif = TRUE;
CREATE INDEX IF NOT EXISTS idx_wl_date       ON whitelist_matchs(match_date);

-- ─── 6. Trigger updated_at automatique ────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hp_updated_at
  BEFORE UPDATE ON historique_performances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_mb_updated_at
  BEFORE UPDATE ON marches_bookmakers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_ac_updated_at
  BEFORE UPDATE ON analyse_confrontation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 7. Quota odds ────────────────────────────────────────────────────────────
-- 'odds' : appels à /odds sur api-football (même clé RapidAPI)
-- Budget total RapidAPI = 100/j → apifootball 40 + odds 55 = 95 (marge 5)
INSERT INTO quota_journalier (date, api, compteur, limite) VALUES
  (CURRENT_DATE, 'odds', 0, 55)
ON CONFLICT DO NOTHING;

-- Mise à jour de quota_consommer pour inclure 'odds'
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
      WHEN 'apifootball'  THEN 40
      WHEN 'odds'         THEN 55
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

-- ─── 8. Fonction SQL : recherche_cote_marche ──────────────────────────────────
-- Permet à l'IA de faire des requêtes complexes sur n'importe quel marché :
-- SELECT * FROM recherche_cote_marche('corners', '8.5', 'over', 2.0);
-- SELECT * FROM recherche_cote_marche('1x2', NULL, 'domicile', 2.5);
CREATE OR REPLACE FUNCTION recherche_cote_marche(
  p_marche    TEXT,         -- 'corners', '1x2', 'over_under', 'btts', ...
  p_ligne     TEXT,         -- '8.5', '2.5' — NULL si non applicable
  p_selection TEXT,         -- 'over', 'under', 'domicile', 'nul', 'oui', 'non', ...
  p_min_cote  NUMERIC DEFAULT 1.0
)
RETURNS TABLE (
  match_id      TEXT,
  bookmaker     TEXT,
  cote          NUMERIC,
  updated_at    TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ligne IS NOT NULL THEN
    -- Marché avec ligne (Over/Under, Corners, Cartons, Handicap)
    RETURN QUERY
      SELECT
        mb.match_id,
        mb.nom_bookmaker,
        (mb.marche_donnees->'marches'->p_marche->p_ligne->>p_selection)::numeric AS cote,
        mb.updated_at
      FROM marches_bookmakers mb
      WHERE
        mb.marche_donnees->'marches'->p_marche->p_ligne IS NOT NULL
        AND (mb.marche_donnees->'marches'->p_marche->p_ligne->>p_selection)::numeric >= p_min_cote
      ORDER BY cote DESC;
  ELSE
    -- Marché sans ligne (1X2, BTTS, Double Chance, Mi-Temps)
    RETURN QUERY
      SELECT
        mb.match_id,
        mb.nom_bookmaker,
        (mb.marche_donnees->'marches'->p_marche->>p_selection)::numeric AS cote,
        mb.updated_at
      FROM marches_bookmakers mb
      WHERE
        mb.marche_donnees->'marches'->p_marche IS NOT NULL
        AND (mb.marche_donnees->'marches'->p_marche->>p_selection)::numeric >= p_min_cote
      ORDER BY cote DESC;
  END IF;
END;
$$;

-- ─── 9. Vue matérialisée : meilleure_cote_par_match ──────────────────────────
-- Agrège la meilleure cote disponible par marché et par match (tous bookmakers)
CREATE MATERIALIZED VIEW IF NOT EXISTS meilleure_cote_par_match AS
SELECT
  match_id,
  MAX((marche_donnees->'marches'->'1x2'->>'domicile')::numeric)        AS best_cote_domicile,
  MAX((marche_donnees->'marches'->'1x2'->>'nul')::numeric)             AS best_cote_nul,
  MAX((marche_donnees->'marches'->'1x2'->>'exterieur')::numeric)       AS best_cote_exterieur,
  MAX((marche_donnees->'marches'->'btts'->>'oui')::numeric)            AS best_btts_oui,
  MAX((marche_donnees->'marches'->'over_under'->'2.5'->>'over')::numeric) AS best_ou25_over,
  MAX((marche_donnees->'marches'->'corners'->'8.5'->>'over')::numeric)    AS best_corners_over85,
  NOW()                                                                  AS calculated_at
FROM marches_bookmakers
GROUP BY match_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meilleure_cote_match_id
  ON meilleure_cote_par_match (match_id);

-- ─── 10. RPC : rafraichir_meilleures_cotes ────────────────────────────────────
-- Appelé par fetch-odds après chaque mise à jour pour garder la vue à jour
CREATE OR REPLACE FUNCTION rafraichir_meilleures_cotes()
RETURNS VOID LANGUAGE plpgsql AS $
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY meilleure_cote_par_match;
END;
$;
