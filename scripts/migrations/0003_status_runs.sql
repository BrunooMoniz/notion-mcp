-- scripts/migrations/0003_status_runs.sql
-- Applied by the migration runner: npm run migrate
--
-- Observability: every indexer/classifier per-source run appends one row here
-- (best-effort telemetry, never blocks a real run). The /status endpoint and
-- the stale-source alert read the LATEST row per (worker, source) so a dead
-- source (e.g. an invalid Notion token indexing 0 silently, or a calendar feed
-- that quietly stopped) surfaces as stale/failing instead of going unnoticed.

CREATE TABLE IF NOT EXISTS status_runs (
  id          bigserial PRIMARY KEY,
  worker      text NOT NULL,        -- 'indexer' | 'classifier'
  source      text NOT NULL,        -- e.g. 'notion-personal','granola-personal','calendar','classifier','revisitar','granola-reuniao'
  ok          boolean NOT NULL,
  counts      jsonb,                -- per-source counts (documents/chunks or classifier stats)
  error       text,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS status_runs_source_idx ON status_runs (worker, source, ended_at DESC);
