-- 0016: marcador de extração de entidades concluída por chunk.
-- Uma extração bem-sucedida que encontra ZERO entidades não cria nenhuma
-- entity_mention, então a seleção "NOT EXISTS entity_mentions" re-selecionava
-- (e re-pagava no LLM) os mesmos chunks em todo run, e o loop do backfill
-- nunca terminava. Chunks com mentions não precisam de linha aqui (já são
-- excluídos pela outra condição).
CREATE TABLE IF NOT EXISTS entity_extraction_done (
  chunk_id   text PRIMARY KEY,
  account_id text NOT NULL,
  done_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_extraction_done_acct_idx
  ON entity_extraction_done (account_id);
