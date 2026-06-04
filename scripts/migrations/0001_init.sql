-- scripts/migrations/0001_init.sql
-- Applied by the migration runner: npm run migrate

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE accent-insensitive TS config via dictionary mapping
-- (NOT a direct unaccent() call, which is only STABLE). Must exist before the
-- brain_chunks.tsv generated column references it.
DROP TEXT SEARCH CONFIGURATION IF EXISTS portuguese_unaccent;
CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent ( COPY = portuguese );
ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
  ALTER MAPPING FOR hword, hword_part, word
  WITH unaccent, portuguese_stem;

CREATE TABLE IF NOT EXISTS brain_chunks (
  id              text PRIMARY KEY,
  source_type     text NOT NULL,
  source_id       text NOT NULL,
  workspace       text,
  db_name         text,
  parent_url      text,
  chunk_index     int NOT NULL,
  text            text NOT NULL,
  embedding       vector(1024),
  tsv             tsvector
                    GENERATED ALWAYS AS (to_tsvector('portuguese_unaccent', text)) STORED,
  metadata        jsonb,
  indexed_at      timestamptz DEFAULT now(),
  source_updated  timestamptz
);

CREATE INDEX IF NOT EXISTS brain_chunks_embedding_idx
  ON brain_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX IF NOT EXISTS brain_chunks_tsv_idx
  ON brain_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS brain_chunks_text_trgm_idx
  ON brain_chunks USING GIN (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS brain_chunks_source_idx
  ON brain_chunks (source_type, source_id);
CREATE INDEX IF NOT EXISTS brain_chunks_workspace_idx
  ON brain_chunks (workspace, db_name);
CREATE INDEX IF NOT EXISTS brain_chunks_metadata_idx
  ON brain_chunks USING GIN (metadata);

CREATE TABLE IF NOT EXISTS sync_state (
  source_type text PRIMARY KEY,
  last_sync_at timestamptz NOT NULL DEFAULT '1970-01-01'
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash  text PRIMARY KEY,
  embedding  vector(1024) NOT NULL,
  created_at timestamptz DEFAULT now()
);
