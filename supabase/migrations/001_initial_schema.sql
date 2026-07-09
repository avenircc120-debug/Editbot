-- =============================================
-- Moteur de Pronostics Sportifs Automatisé
-- Table 1: Historique des matchs
-- =============================================
CREATE TABLE IF NOT EXISTS matchs_historique (
  id                BIGSERIAL PRIMARY KEY,
  match_id          TEXT UNIQUE NOT NULL,         -- ID SofaScore
  competition       TEXT NOT NULL,                -- Ex: "Ligue 1", "Champions League"
  competition_id    TEXT,                         -- ID de la compétition
  home_team         TEXT NOT NULL,
  away_team         TEXT NOT NULL,
  home_team_id      TEXT,
  away_team_id      TEXT,
  match_date        TIMESTAMPTZ NOT NULL,
  status            TEXT DEFAULT 'scheduled',     -- scheduled | finished | postponed
  home_score        INTEGER,
  away_score        INTEGER,
  statistics        JSONB DEFAULT '{}',           -- Stats brutes du match
  h2h               JSONB DEFAULT '[]',           -- Historique H2H
  home_form         JSONB DEFAULT '[]',           -- Forme équipe domicile (5 derniers)
  away_form         JSONB DEFAULT '[]',           -- Forme équipe extérieur (5 derniers)
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Table 2: Pronostics pré-calculés (cache IA)
-- =============================================
CREATE TABLE IF NOT EXISTS pronostics_pre_calcules (
  id                BIGSERIAL PRIMARY KEY,
  match_id          TEXT NOT NULL REFERENCES matchs_historique(match_id) ON DELETE CASCADE,
  competition       TEXT NOT NULL,
  home_team         TEXT NOT NULL,
  away_team         TEXT NOT NULL,
  match_date        TIMESTAMPTZ NOT NULL,
  pronostic_type    TEXT NOT NULL,               -- 1X2 | score_exact | btts | over_under | double_chance
  pronostic_valeur  TEXT NOT NULL,               -- Ex: "1", "2-1", "BTTS Oui", "Plus de 2.5"
  cote_conseille    DECIMAL(5,2),                -- Cote recommandée
  fiabilite         INTEGER CHECK (fiabilite BETWEEN 0 AND 100),  -- Score 0-100%
  analyse_texte     TEXT,                        -- Texte d'analyse généré par Groq
  tokens_utilises   INTEGER DEFAULT 0,
  expires_at        TIMESTAMPTZ,                 -- Expiration du cache
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Index pour optimiser les requêtes
-- =============================================
CREATE INDEX IF NOT EXISTS idx_matchs_date ON matchs_historique(match_date);
CREATE INDEX IF NOT EXISTS idx_matchs_competition ON matchs_historique(competition);
CREATE INDEX IF NOT EXISTS idx_matchs_status ON matchs_historique(status);
CREATE INDEX IF NOT EXISTS idx_pronostics_match_id ON pronostics_pre_calcules(match_id);
CREATE INDEX IF NOT EXISTS idx_pronostics_competition ON pronostics_pre_calcules(competition);
CREATE INDEX IF NOT EXISTS idx_pronostics_type ON pronostics_pre_calcules(pronostic_type);
CREATE INDEX IF NOT EXISTS idx_pronostics_date ON pronostics_pre_calcules(match_date);

-- =============================================
-- Vue utile: matchs avec pronostics
-- =============================================
CREATE OR REPLACE VIEW v_matchs_avec_pronostics AS
SELECT
  m.match_id,
  m.competition,
  m.home_team,
  m.away_team,
  m.match_date,
  m.status,
  COUNT(p.id) AS nb_pronostics,
  MAX(p.created_at) AS dernier_pronostic
FROM matchs_historique m
LEFT JOIN pronostics_pre_calcules p ON m.match_id = p.match_id
GROUP BY m.match_id, m.competition, m.home_team, m.away_team, m.match_date, m.status;
