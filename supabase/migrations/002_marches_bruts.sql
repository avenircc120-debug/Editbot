-- =============================================
-- Migration 002: Système d'ingestion dynamique
-- Remplace matchs_historique par une architecture
-- flexible basée sur JSONB
-- =============================================

-- Table d'index légère (métadonnées du match uniquement)
CREATE TABLE IF NOT EXISTS matchs_index (
  match_id       TEXT PRIMARY KEY,
  home_team      TEXT NOT NULL,
  away_team      TEXT NOT NULL,
  home_team_id   TEXT,
  away_team_id   TEXT,
  home_slug      TEXT,
  away_slug      TEXT,
  competition    TEXT NOT NULL,
  tournament_id  TEXT,
  season_id      TEXT,
  match_date     TIMESTAMPTZ NOT NULL,
  status         TEXT DEFAULT 'scheduled',   -- scheduled | finished | inprogress | postponed
  home_score     INTEGER,
  away_score     INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Table flexible: absorbe TOUT marché présent ou futur
-- Un enregistrement = un type de données pour un match
CREATE TABLE IF NOT EXISTS marches_bruts (
  id             BIGSERIAL PRIMARY KEY,
  match_id       TEXT NOT NULL REFERENCES matchs_index(match_id) ON DELETE CASCADE,
  marche_slug    TEXT NOT NULL,             -- ex: "h2h", "statistiques", "lineups", "incidents", "shotmap", "odds"
  donnees        JSONB NOT NULL,            -- Réponse API brute complète
  source         TEXT DEFAULT 'sofascore',
  fetched_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(match_id, marche_slug)             -- Un seul enregistrement par type par match
);

-- Index pour requêtes rapides
CREATE INDEX IF NOT EXISTS idx_matchs_date    ON matchs_index(match_date);
CREATE INDEX IF NOT EXISTS idx_matchs_status  ON matchs_index(status);
CREATE INDEX IF NOT EXISTS idx_matchs_comp    ON matchs_index(competition);
CREATE INDEX IF NOT EXISTS idx_marches_match  ON marches_bruts(match_id);
CREATE INDEX IF NOT EXISTS idx_marches_slug   ON marches_bruts(marche_slug);
CREATE INDEX IF NOT EXISTS idx_marches_fetched ON marches_bruts(fetched_at);

-- Index GIN pour requêtes JSONB (recherche dans les données)
CREATE INDEX IF NOT EXISTS idx_marches_donnees ON marches_bruts USING GIN(donnees);

-- Vue: matchs avec leurs types de données disponibles
CREATE OR REPLACE VIEW v_matchs_disponibles AS
SELECT
  m.match_id,
  m.competition,
  m.home_team,
  m.away_team,
  m.match_date,
  m.status,
  ARRAY_AGG(mb.marche_slug ORDER BY mb.marche_slug) AS types_disponibles,
  COUNT(mb.id) AS nb_types,
  MAX(mb.fetched_at) AS derniere_maj
FROM matchs_index m
LEFT JOIN marches_bruts mb ON m.match_id = mb.match_id
GROUP BY m.match_id, m.competition, m.home_team, m.away_team, m.match_date, m.status;

-- Garder pronostics_pre_calcules, référencer matchs_index
ALTER TABLE pronostics_pre_calcules
  DROP CONSTRAINT IF EXISTS pronostics_pre_calcules_match_id_fkey;
