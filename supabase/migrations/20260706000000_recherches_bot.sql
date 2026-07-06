-- Migration : table recherches_bot
    CREATE TABLE IF NOT EXISTS public.recherches_bot (
    id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    query          text        NOT NULL,
    total_results  integer     NOT NULL DEFAULT 0,
    results        jsonb       NOT NULL DEFAULT '[]',
    source         text        NOT NULL DEFAULT 'google_custom_search',
    created_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_recherches_bot_query      ON public.recherches_bot (query);
    CREATE INDEX IF NOT EXISTS idx_recherches_bot_created_at ON public.recherches_bot (created_at DESC);

    ALTER TABLE public.recherches_bot ENABLE ROW LEVEL SECURITY;
    