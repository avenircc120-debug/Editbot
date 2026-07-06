-- Migration : config_bot + analyse_ia_groq + logs_predictions
-- Date : 2026-07-06

CREATE TABLE IF NOT EXISTS public.config_bot (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.config_bot ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Service role only" ON public.config_bot USING (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS public.analyse_ia_groq (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  competition TEXT NOT NULL, match TEXT NOT NULL, marche TEXT NOT NULL DEFAULT '1X2',
  analyse TEXT, prediction TEXT,
  confiance INTEGER CHECK (confiance BETWEEN 0 AND 100),
  action TEXT CHECK (action IN ('JOUER','NE PAS JOUER')),
  envoye BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analyse_competition ON public.analyse_ia_groq (competition);
CREATE INDEX IF NOT EXISTS idx_analyse_confiance   ON public.analyse_ia_groq (confiance DESC);
CREATE INDEX IF NOT EXISTS idx_analyse_envoye      ON public.analyse_ia_groq (envoye) WHERE envoye = false;
CREATE INDEX IF NOT EXISTS idx_analyse_timestamp   ON public.analyse_ia_groq (timestamp DESC);
ALTER TABLE public.analyse_ia_groq ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Service role only" ON public.analyse_ia_groq USING (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS public.logs_predictions (
  id BIGSERIAL PRIMARY KEY,
  date TIMESTAMPTZ NOT NULL DEFAULT now(),
  competition TEXT NOT NULL, match TEXT NOT NULL, marche TEXT,
  prediction TEXT, confiance INTEGER, action TEXT,
  resultat_reel TEXT, roi NUMERIC(8,2), envoye_telegram BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_competition ON public.logs_predictions (competition);
CREATE INDEX IF NOT EXISTS idx_logs_date        ON public.logs_predictions (date DESC);
ALTER TABLE public.logs_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Service role only" ON public.logs_predictions USING (auth.role() = 'service_role');