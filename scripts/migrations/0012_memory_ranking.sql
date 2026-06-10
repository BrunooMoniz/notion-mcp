-- 0012_memory_ranking.sql
-- Spec 004: Ranking de memórias por utilidade.
-- Aditiva: nenhuma coluna/tabela existente é alterada.

-- 1. Adicionar colunas de utilidade em brain_chunks
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS utility_score REAL NOT NULL DEFAULT 0;
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS feedback_count INT NOT NULL DEFAULT 0;
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS last_useful_at TIMESTAMPTZ;

-- 2. Livro-razão auditável de feedback
CREATE TABLE IF NOT EXISTS chunk_feedback (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  source TEXT NOT NULL,        -- 'user_thumb' | 'assistant' | 'implicit_cited' | 'implicit_action'
  value REAL NOT NULL,         -- delta aplicado (ver pesos em utility.ts)
  query TEXT,                  -- pergunta que originou (truncada 300)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunk_feedback_chunk ON chunk_feedback(chunk_id);
CREATE INDEX IF NOT EXISTS chunk_feedback_account ON chunk_feedback(account_id, created_at);

-- 3. Função SQL: utilidade efetiva com decay lazy (DECAY=0.995/dia)
CREATE OR REPLACE FUNCTION effective_utility(
  score REAL,
  last_useful_at TIMESTAMPTZ
) RETURNS REAL
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN last_useful_at IS NULL THEN score
    ELSE score * POWER(0.995::REAL,
      GREATEST(0.0, EXTRACT(EPOCH FROM (now() - last_useful_at)) / 86400.0)::REAL)
  END
$$;

-- 4. View: memórias obsoletas (candidatas a arquivamento manual)
CREATE OR REPLACE VIEW stale_memories AS
SELECT
  c.id,
  c.account_id,
  c.source_type,
  c.parent_url,
  c.chunk_index,
  length(c.text) AS text_length,
  c.utility_score,
  c.feedback_count,
  c.last_useful_at,
  c.source_updated,
  effective_utility(c.utility_score, c.last_useful_at) AS eff_utility
FROM brain_chunks c
WHERE
  effective_utility(c.utility_score, c.last_useful_at) < -2
  OR (
    c.source_updated < now() - interval '180 days'
    AND c.utility_score = 0
    AND c.last_useful_at IS NULL
  );
