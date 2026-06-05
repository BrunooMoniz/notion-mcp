-- scripts/migrations/0004_brain_facts.sql
-- Applied by the migration runner: npm run migrate
--
-- F2.3 — lightweight TEMPORAL FACTS store (subject-predicate-object + validity
-- window) in plain Postgres (NO graph DB). The brain-classifier (gated behind
-- FACTS_ENABLED) extracts durable facts from passages and writes them here;
-- queries answer "what was true about X on date D" via the valid_from/valid_to
-- window. This migration is purely ADDITIVE and idempotent — creating the table
-- + indexes is safe to run unconditionally on every deploy and does NOTHING the
-- second time. No existing table is touched.

CREATE TABLE IF NOT EXISTS brain_facts (
  id          bigserial PRIMARY KEY,
  subject     text NOT NULL,
  predicate   text NOT NULL,
  object      text NOT NULL,
  workspace   text,
  source_id   text,           -- provenance: which chunk/doc this came from
  source_type text,
  confidence  real,           -- 0..1 from the extractor
  valid_from  date,           -- when the fact became true (nullable)
  valid_to    date,           -- when it stopped being true (null = still true)
  extracted_at timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb
);

CREATE INDEX IF NOT EXISTS brain_facts_subject_idx ON brain_facts (lower(subject));
CREATE INDEX IF NOT EXISTS brain_facts_ws_idx ON brain_facts (workspace);
CREATE INDEX IF NOT EXISTS brain_facts_spo_idx ON brain_facts (lower(subject), lower(predicate));
