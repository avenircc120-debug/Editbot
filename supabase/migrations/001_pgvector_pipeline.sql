-- ═══════════════════════════════════════════════════════════════
--  Editbot Football Intelligence — Schema complet
--  Phase 1 : pgvector + 3 tables maîtres
-- ═══════════════════════════════════════════════════════════════

-- Extension pgvector pour la recherche sémantique
create extension if not exists vector;
create extension if not exists "uuid-ossp";

-- ── Table 1 : RAW_WEB_DATA (buffer de recherche brute) ──────────
create table if not exists raw_web_data (
  id          uuid primary key default gen_random_uuid(),
  query       text not null,
  source_url  text,
  title       text,
  snippet     text,
  content     text,
  embedding   vector(768),
  processed   boolean default false,
  created_at  timestamptz default now(),
  expires_at  timestamptz default now() + interval '24 hours'
);

create index if not exists idx_raw_web_data_embedding
  on raw_web_data using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
create index if not exists idx_raw_web_data_query
  on raw_web_data (query);
create index if not exists idx_raw_web_data_unprocessed
  on raw_web_data (processed, created_at desc)
  where processed = false;

-- ── Table 2 : ANALYSE_GROQ (synthèses IA avec expiration) ───────
create table if not exists analyse_groq (
  id          uuid primary key default gen_random_uuid(),
  query       text not null,
  synthese    text not null,
  sources     jsonb default '[]',
  embedding   vector(768),
  created_at  timestamptz default now(),
  expires_at  timestamptz default now() + interval '6 hours'
);

create index if not exists idx_analyse_groq_embedding
  on analyse_groq using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
create index if not exists idx_analyse_groq_expiry
  on analyse_groq (expires_at desc);

-- ── Table 3 : BASE_CONNAISSANCE (mémoire long terme + templates) ─
create table if not exists base_connaissance (
  id          uuid primary key default gen_random_uuid(),
  sujet       text not null,
  contenu     text not null,
  template    text,
  tags        text[] default '{}',
  embedding   vector(768),
  updated_at  timestamptz default now()
);

create index if not exists idx_base_connaissance_embedding
  on base_connaissance using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ── Fonction : recherche sémantique dans BASE_CONNAISSANCE ───────
create or replace function search_knowledge(
  query_embedding vector(768),
  match_threshold float default 0.70,
  match_count     int   default 5
)
returns table (
  id         uuid,
  sujet      text,
  contenu    text,
  template   text,
  similarity float
)
language sql stable as $$
  select id, sujet, contenu, template,
         1 - (embedding <=> query_embedding) as similarity
  from base_connaissance
  where embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── Fonction : recherche sémantique dans ANALYSE_GROQ (fraîches) ─
create or replace function search_analyses(
  query_embedding vector(768),
  match_threshold float default 0.75,
  match_count     int   default 3
)
returns table (
  id         uuid,
  query      text,
  synthese   text,
  created_at timestamptz,
  similarity float
)
language sql stable as $$
  select id, query, synthese, created_at,
         1 - (embedding <=> query_embedding) as similarity
  from analyse_groq
  where embedding is not null
    and expires_at > now()
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── Vue de synchronisation Sheets → Supabase ─────────────────────
create or replace view v_sheets_raw_web_data as
  select
    id, query, title, snippet, source_url,
    created_at, processed, expires_at
  from raw_web_data
  order by created_at desc
  limit 500;

create or replace view v_sheets_analyse_groq as
  select
    id, query, synthese, created_at, expires_at,
    sources::text as sources_json
  from analyse_groq
  order by created_at desc
  limit 200;

create or replace view v_sheets_base_connaissance as
  select id, sujet, contenu, template, tags, updated_at
  from base_connaissance
  order by updated_at desc;
