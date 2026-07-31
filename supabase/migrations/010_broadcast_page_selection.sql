-- Migration 010 — diffusion multi-pages
-- Une sélection de diffusion appartient à un utilisateur et peut cibler
-- plusieurs pages. Les Page Access Tokens restent uniquement dans
-- facebook_connections et ne sont jamais exposés au client web.

CREATE TABLE IF NOT EXISTS broadcast_selections (
  id                BIGSERIAL PRIMARY KEY,
  telegram_user_id  BIGINT NOT NULL REFERENCES user_profiles(telegram_user_id) ON DELETE CASCADE,
  match_id          TEXT NOT NULL,
  competition       TEXT,
  home_team         TEXT,
  away_team         TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  fb_page_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_broadcast_selection_user_match UNIQUE (telegram_user_id, match_id)
);

ALTER TABLE broadcast_selections
  ADD COLUMN IF NOT EXISTS competition TEXT,
  ADD COLUMN IF NOT EXISTS home_team TEXT,
  ADD COLUMN IF NOT EXISTS away_team TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE broadcast_selections
  ADD COLUMN IF NOT EXISTS fb_page_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE broadcast_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only_broadcast_selections ON broadcast_selections;
CREATE POLICY service_role_only_broadcast_selections
  ON broadcast_selections
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_selection_user_match_idx
  ON broadcast_selections(telegram_user_id, match_id);

CREATE INDEX IF NOT EXISTS idx_broadcast_selections_active_match
  ON broadcast_selections(match_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_broadcast_selections_user
  ON broadcast_selections(telegram_user_id);