-- =============================================
-- Migration 006 — pronostics_finaux
-- Table de consultation finale : le bot Telegram ne lit QUE cette table.
-- Alimentée par analyse-matches à partir de :
--   - historique_performances (données brutes / stats)
--   - marches_bookmakers      (cotes brutes)
--   - analyse_confrontation   (moteur de calcul H2H + moyennes + confiance)
-- =============================================

CREATE TABLE IF NOT EXISTS pronostics_finaux (
  id                BIGSERIAL PRIMARY KEY,
  match_id          TEXT NOT NULL,
  competition       TEXT NOT NULL,
  home_team         TEXT NOT NULL,
  away_team         TEXT NOT NULL,
  match_date        TIMESTAMPTZ NOT NULL,

  pronostic_type    TEXT NOT NULL,               -- 1X2 | BTTS | Over/Under 2.5 | Double Chance | ...
  pronostic_valeur  TEXT NOT NULL,               -- Ex: "1", "BTTS Oui", "Plus de 2.5"
  cote_conseille    DECIMAL(5,2),
  fiabilite         INTEGER CHECK (fiabilite BETWEEN 0 AND 100),
  confiance_score   INTEGER CHECK (confiance_score BETWEEN 0 AND 100),  -- reporté depuis analyse_confrontation
  analyse_texte     TEXT,

  -- Cache : ce pronostic n'est jamais recalculé tant qu'il est valide
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_pronostics_finaux_match_type UNIQUE (match_id, pronostic_type)
);

-- Index pour que le bot Telegram réponde en quelques millisecondes
-- (SELECT simple, jamais de JOIN ni de calcul en direct)
CREATE INDEX IF NOT EXISTS idx_pf_match_date  ON pronostics_finaux(match_date);
CREATE INDEX IF NOT EXISTS idx_pf_competition ON pronostics_finaux(competition);
CREATE INDEX IF NOT EXISTS idx_pf_expires_at  ON pronostics_finaux(expires_at);
CREATE INDEX IF NOT EXISTS idx_pf_fiabilite   ON pronostics_finaux(fiabilite);

CREATE TRIGGER trg_pf_updated_at
  BEFORE UPDATE ON pronostics_finaux
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Nettoyage automatique : purge des pronostics expirés depuis plus de 24h
-- pour garder la table de consultation légère (appelable via cron ou manuellement).
CREATE OR REPLACE FUNCTION purger_pronostics_finaux_expires()
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM pronostics_finaux WHERE expires_at < NOW() - INTERVAL '24 hours';
$$;
