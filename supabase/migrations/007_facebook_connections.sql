-- =============================================
-- Migration 007 — facebook_connections
-- Stocke les tokens d'accès aux Pages Facebook des utilisateurs.
-- RLS activé : seul le service_role peut lire/écrire (Edge Functions).
-- =============================================

-- ─── Table principale : connexions Facebook ───────────────────────────────────
CREATE TABLE IF NOT EXISTS facebook_connections (
  id                    BIGSERIAL PRIMARY KEY,
  telegram_user_id      BIGINT NOT NULL,
  fb_user_id            TEXT NOT NULL,
  fb_page_id            TEXT NOT NULL,
  fb_page_name          TEXT NOT NULL,
  fb_page_access_token  TEXT NOT NULL,       -- long-lived token (60 jours)
  is_active             BOOLEAN DEFAULT TRUE,
  last_post_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_fb_telegram_page UNIQUE (telegram_user_id, fb_page_id)
);

ALTER TABLE facebook_connections ENABLE ROW LEVEL SECURITY;

-- Seul le service_role (Edge Functions) peut accéder à cette table.
-- Les tokens de page ne doivent jamais être exposés via l'API REST publique.
CREATE POLICY "service_role_only_connections"
  ON facebook_connections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_fb_active  ON facebook_connections(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_fb_tg_user ON facebook_connections(telegram_user_id);

CREATE TRIGGER trg_fb_updated_at
  BEFORE UPDATE ON facebook_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Table : logs des posts publiés (évite les doublons) ─────────────────────
CREATE TABLE IF NOT EXISTS facebook_posts_log (
  id              BIGSERIAL PRIMARY KEY,
  connection_id   BIGINT NOT NULL REFERENCES facebook_connections(id) ON DELETE CASCADE,
  match_id        TEXT NOT NULL,
  post_date       DATE NOT NULL DEFAULT CURRENT_DATE, -- clé d'idempotence par jour
  pronostic_type  TEXT NOT NULL,
  fb_post_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | success | error
  error_message   TEXT,
  posted_at       TIMESTAMPTZ DEFAULT NOW(),
  -- Idempotence : un seul post par connexion + match + jour
  CONSTRAINT uq_fb_post_log UNIQUE (connection_id, match_id, post_date)
);

ALTER TABLE facebook_posts_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only_posts_log"
  ON facebook_posts_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_fb_log_connection ON facebook_posts_log(connection_id);
CREATE INDEX IF NOT EXISTS idx_fb_log_date       ON facebook_posts_log(post_date);

-- ─── Table : états OAuth (protection CSRF) ────────────────────────────────────
-- Nonce à usage unique, expire après 10 minutes.
CREATE TABLE IF NOT EXISTS facebook_oauth_states (
  nonce            TEXT PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  used             BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE facebook_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only_oauth_states"
  ON facebook_oauth_states
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Nettoyage automatique des états OAuth expirés
CREATE OR REPLACE FUNCTION purger_oauth_states_expires()
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM facebook_oauth_states WHERE expires_at < NOW();
$$;

-- ─── Nettoyage logs > 30 jours ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purger_facebook_posts_log()
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM facebook_posts_log WHERE posted_at < NOW() - INTERVAL '30 days';
$$;

-- ─── RGPD : suppression complète des données d'un utilisateur ────────────────
CREATE OR REPLACE FUNCTION supprimer_donnees_utilisateur(p_telegram_user_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Supprime facebook_connections (cascade sur facebook_posts_log via FK)
  DELETE FROM facebook_connections    WHERE telegram_user_id = p_telegram_user_id;
  -- Supprime les états OAuth en attente
  DELETE FROM facebook_oauth_states   WHERE telegram_user_id = p_telegram_user_id;
  -- Note : les données sportives agrégées (pronostics_finaux, etc.) sont anonymes
  -- et ne contiennent pas d'identifiant personnel — elles ne sont pas supprimées.
END;
$$;
