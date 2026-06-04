-- scripts/migrations/0002_hnsw_unaccent_pgtrgm.sql
-- Requires privileges: CREATE EXTENSION needs superuser; CREATE TEXT SEARCH
-- CONFIGURATION needs config-owner privileges. Run as the DB superuser.

BEGIN;

-- 1. Extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. IMMUTABLE accent-insensitive TS config via dictionary mapping
--    (NOT a direct unaccent() call, which is only STABLE).
DROP TEXT SEARCH CONFIGURATION IF EXISTS portuguese_unaccent;
CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent ( COPY = portuguese );
ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
  ALTER MAPPING FOR hword, hword_part, word
  WITH unaccent, portuguese_stem;

-- 3. Swap ivfflat -> HNSW (cosine)
DROP INDEX IF EXISTS brain_chunks_embedding_idx;
CREATE INDEX brain_chunks_embedding_idx
  ON brain_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 4. Rebuild the generated tsv column to use portuguese_unaccent.
--    A generated column's expression CANNOT be altered in place, so drop &
--    re-add (this REWRITES the table; fine for the small corpus).
DROP INDEX IF EXISTS brain_chunks_tsv_idx;
ALTER TABLE brain_chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE brain_chunks
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('portuguese_unaccent', text)) STORED;
CREATE INDEX brain_chunks_tsv_idx ON brain_chunks USING GIN (tsv);

-- 5. pg_trgm GIN on raw text for proper-noun fallback (ILIKE / similarity)
CREATE INDEX IF NOT EXISTS brain_chunks_text_trgm_idx
  ON brain_chunks USING GIN (text gin_trgm_ops);

COMMIT;
