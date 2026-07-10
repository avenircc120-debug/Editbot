-- =============================================
-- Migration 007 — facebook_connections
-- Stocke les tokens d'accès aux Pages Facebook des utilisateurs.
-- Chaque utilisateur Telegram peut connecter une ou plusieurs Pages.
-- =============================================

CREATE TABLE IF NOT EXISTS facebook_connections (
  id                    BIGSERIAL PRIMARY KEY,
  telegram_user_id      BIGINT NOT NULL,
  fb_user_id            TEXT NOT NULL,
  fb_page_id            TEXT NOT NULL,
  fb_page_name          TEXT NOT NULL,
  fb_page_access_token  TEXT NOT NULL,       -- token longue durée (60 jours)
  is_active             BOOLEAN DEFAULT TRUE,
  last_post_at          TIMESTAMPTZ,         -- dernier post réussi
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_fb_telegram_page UNIQUE (telegram_user_id, fb_page_id)
);

CREATE INDEX IF NOT EXISTS idx_fb_active  ON facebook_connections(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_fb_tg_user ON facebook_connections(telegram_user_id);

CREATE TRIGGER trg_fb_updated_at
  BEFORE UPDATE ON facebook_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trace des posts publiés (évite les doublons)
CREATE TABLE IF NOT EXISTS facebook_posts_log (
  id              BIGSERIAL PRIMARY KEY,
  connection_id   BIGINT REFERENCES facebook_connections(id) ON DELETE CASCADE,
  match_id        TEXT NOT NULL,
  pronostic_type  TEXT NOT NULL,
  fb_post_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | success | error
  error_message   TEXT,
  posted_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_fb_post_log UNIQUE (connection_id, match_id, pronostic_type)
);

-- Nettoyage automatique des logs > 30 jours
CREATE OR REPLACE FUNCTION purger_facebook_posts_log()
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM facebook_posts_log WHERE posted_at < NOW() - INTERVAL '30 days';
$$;

-- RGPD : suppression complète des données d'un utilisateur
CREATE OR REPLACE FUNCTION supprimer_donnees_utilisateur(p_telegram_user_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM facebook_connections WHERE telegram_user_id = p_telegram_user_id;
END;
$$;
