-- scripts/migrations/0011_entities.sql
-- additive, idempotente, sem ALTER em tabela existente.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION array_distinct(anyarray) RETURNS anyarray AS $$
  SELECT ARRAY(SELECT DISTINCT unnest($1))
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS entities (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  type        text NOT NULL CHECK (type IN ('pessoa','empresa','projeto')),
  name        text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, type, name)
);

CREATE INDEX IF NOT EXISTS entities_account_type_idx  ON entities (account_id, type);
CREATE INDEX IF NOT EXISTS entities_name_trgm_idx     ON entities USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entities_aliases_idx       ON entities USING GIN (aliases);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id           bigserial PRIMARY KEY,
  entity_id    bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id     text NOT NULL,
  confidence   real CHECK (confidence BETWEEN 0 AND 1),
  extracted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS entity_mentions_entity_idx ON entity_mentions (entity_id);
CREATE INDEX IF NOT EXISTS entity_mentions_chunk_idx  ON entity_mentions (chunk_id);
