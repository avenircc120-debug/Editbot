-- Migration 006 — Profils utilisateurs, connexions Facebook (OAuth réparé),
-- compétitions suivies et coupons (espace de vente / social betting).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_profiles (
  telegram_user_id   BIGINT PRIMARY KEY,
  onboarded          BOOLEAN DEFAULT FALSE,
  web_access_token   UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facebook_oauth_states (
  nonce              TEXT PRIMARY KEY,
  telegram_user_id   BIGINT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_connections (
  id                    BIGSERIAL PRIMARY KEY,
  telegram_user_id      BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  fb_user_id            TEXT,
  fb_page_id            TEXT NOT NULL,
  fb_page_name          TEXT,
  fb_page_access_token  TEXT NOT NULL,
  is_active             BOOLEAN DEFAULT TRUE,
  last_post_at          TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(telegram_user_id, fb_page_id)
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_fb_updated_at ON facebook_connections;
CREATE TRIGGER trg_fb_updated_at BEFORE UPDATE ON facebook_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS facebook_posts_log (
  id              BIGSERIAL PRIMARY KEY,
  connection_id   BIGINT NOT NULL REFERENCES facebook_connections(id) ON DELETE CASCADE,
  match_id        TEXT NOT NULL,
  post_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  fb_post_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  posted_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_fb_post_log UNIQUE (connection_id, match_id, post_date)
);

CREATE TABLE IF NOT EXISTS user_competitions (
  telegram_user_id   BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  competition        TEXT NOT NULL,
  active             BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (telegram_user_id, competition)
);

CREATE TABLE IF NOT EXISTS coupons (
  id                 BIGSERIAL PRIMARY KEY,
  telegram_user_id   BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  bookmaker          TEXT NOT NULL CHECK (bookmaker IN ('1xbet', '1win')),
  code               TEXT NOT NULL,
  description        TEXT,
  price              NUMERIC(10,2),
  active             BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_competitions_user ON user_competitions(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_coupons_user ON coupons(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_facebook_connections_user ON facebook_connections(telegram_user_id);

ALTER TABLE facebook_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_posts_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only_connections ON facebook_connections;
CREATE POLICY service_role_only_connections ON facebook_connections FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only_oauth_states ON facebook_oauth_states;
CREATE POLICY service_role_only_oauth_states ON facebook_oauth_states FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only_posts_log ON facebook_posts_log;
CREATE POLICY service_role_only_posts_log ON facebook_posts_log FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only_profiles ON user_profiles;
CREATE POLICY service_role_only_profiles ON user_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only_competitions ON user_competitions;
CREATE POLICY service_role_only_competitions ON user_competitions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only_coupons ON coupons;
CREATE POLICY service_role_only_coupons ON coupons FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION purger_oauth_states_expires()
RETURNS VOID LANGUAGE sql AS $$ DELETE FROM facebook_oauth_states WHERE expires_at < NOW(); $$;

CREATE OR REPLACE FUNCTION supprimer_donnees_utilisateur(p_telegram_user_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM facebook_connections  WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM facebook_oauth_states WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM user_competitions     WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM coupons               WHERE telegram_user_id = p_telegram_user_id;
  DELETE FROM user_profiles         WHERE telegram_user_id = p_telegram_user_id;
END;
$$;
