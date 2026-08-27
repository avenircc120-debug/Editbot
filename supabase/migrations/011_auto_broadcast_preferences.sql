-- Migration 011 — Préférences "Set & Forget" et sélection automatique du match du jour
--
-- user_competitions était définie dans la migration 006 mais n'a jamais été
-- appliquée en production (absente de la base live) : on la (re)crée ici
-- pour servir de stockage aux compétitions suivies en mode automatique.
-- Ajoute l'équipe favorite sur user_profiles et une table de traçabilité
-- pour rendre le cron idempotent (un seul choix par utilisateur par jour,
-- même si le cron tourne plusieurs fois).

CREATE TABLE IF NOT EXISTS user_competitions (
  telegram_user_id   BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  competition        TEXT NOT NULL,
  active             BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (telegram_user_id, competition)
);

CREATE INDEX IF NOT EXISTS idx_user_competitions_user ON user_competitions(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_user_competitions_active ON user_competitions(telegram_user_id) WHERE active = TRUE;

ALTER TABLE user_competitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only_competitions ON user_competitions;
CREATE POLICY service_role_only_competitions ON user_competitions FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS favorite_team_id       TEXT,
  ADD COLUMN IF NOT EXISTS favorite_team_name     TEXT,
  ADD COLUMN IF NOT EXISTS auto_broadcast_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS preferences_onboarded  BOOLEAN NOT NULL DEFAULT FALSE;

-- Traçabilité du choix automatique quotidien.
-- UNIQUE(telegram_user_id, run_date) = garde-fou d'idempotence : le cron peut
-- tourner plusieurs fois le même jour sans jamais changer le match déjà choisi.
CREATE TABLE IF NOT EXISTS auto_broadcast_log (
  id                BIGSERIAL PRIMARY KEY,
  telegram_user_id  BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  run_date          DATE NOT NULL,
  match_id          TEXT,
  reason            TEXT NOT NULL CHECK (reason IN ('favorite_team', 'followed_competition', 'no_match')),
  competition       TEXT,
  home_team         TEXT,
  away_team         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_auto_broadcast_log_user_day UNIQUE (telegram_user_id, run_date)
);

CREATE INDEX IF NOT EXISTS idx_auto_broadcast_log_user ON auto_broadcast_log(telegram_user_id);

ALTER TABLE auto_broadcast_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only_auto_broadcast_log ON auto_broadcast_log;
CREATE POLICY service_role_only_auto_broadcast_log
  ON auto_broadcast_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- RGPD : purge des nouvelles données lors de la suppression d'un utilisateur.
CREATE OR REPLACE FUNCTION supprimer_donnees_utilisateur(p_telegram_user_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM facebook_connections  WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM facebook_oauth_states WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM user_competitions     WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM auto_broadcast_log    WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM coupons               WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM broadcast_selections  WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM user_profiles         WHERE telegram_user_id = p_telegram_user_id;
END;
$$;
