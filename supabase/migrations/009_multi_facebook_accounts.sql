-- =============================================
-- Migration 009 — Support multi-comptes Facebook
-- Ajoute fb_user_name pour identifier visuellement
-- chaque compte Facebook connecté.
-- =============================================

-- Colonne pour le nom affiché du compte Facebook (ex: "Jean Dupont")
ALTER TABLE facebook_connections
  ADD COLUMN IF NOT EXISTS fb_user_name TEXT;

-- Index pour accélérer les requêtes par compte Facebook
CREATE INDEX IF NOT EXISTS idx_fb_connections_fb_user
  ON facebook_connections(telegram_user_id, fb_user_id)
  WHERE is_active = TRUE;
