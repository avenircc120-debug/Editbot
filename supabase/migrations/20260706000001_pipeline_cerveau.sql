-- Migration : tables scraping_temp + archive_stats
-- Date : 2026-07-06

-- ── scraping_temp : zone de passage pour données brutes ──────────────────────
CREATE TABLE IF NOT EXISTS public.scraping_temp (
  id            TEXT PRIMARY KEY,
  date_scraping TIMESTAMPTZ NOT NULL DEFAULT now(),
  competition   TEXT NOT NULL,
  match         TEXT NOT NULL,
  date_match    TEXT,
  score         TEXT DEFAULT '',
  stats_json    TEXT DEFAULT '{}',
  traite        BOOLEAN NOT NULL DEFAULT false,
  source_url    TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_scraping_temp_traite       ON public.scraping_temp (traite);
CREATE INDEX IF NOT EXISTS idx_scraping_temp_competition  ON public.scraping_temp (competition);

ALTER TABLE public.scraping_temp ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON public.scraping_temp
  USING (auth.role() = 'service_role');

-- ── archive_stats : mémoire historique ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.archive_stats (
  id              TEXT PRIMARY KEY,
  date            TIMESTAMPTZ,
  competition     TEXT NOT NULL,
  equipe_dom      TEXT NOT NULL,
  equipe_ext      TEXT NOT NULL,
  score_dom       INTEGER,
  score_ext       INTEGER,
  possession_dom  NUMERIC(5,2),
  possession_ext  NUMERIC(5,2),
  tirs_dom        INTEGER,
  tirs_ext        INTEGER,
  tirs_cadres_dom INTEGER,
  tirs_cadres_ext INTEGER,
  corners_dom     INTEGER,
  corners_ext     INTEGER,
  fautes_dom      INTEGER,
  fautes_ext      INTEGER,
  cote_dom        NUMERIC(6,2),
  cote_nul        NUMERIC(6,2),
  cote_ext        NUMERIC(6,2),
  source          TEXT DEFAULT '',
  fiabilite       TEXT DEFAULT 'scraping',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_archive_competition  ON public.archive_stats (competition);
CREATE INDEX IF NOT EXISTS idx_archive_equipes      ON public.archive_stats (equipe_dom, equipe_ext);
CREATE INDEX IF NOT EXISTS idx_archive_date         ON public.archive_stats (date DESC);

ALTER TABLE public.archive_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON public.archive_stats
  USING (auth.role() = 'service_role');
