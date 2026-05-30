-- scripts/verify-f2.sql
SELECT amname AS index_method
FROM pg_class c
JOIN pg_am a ON a.oid = c.relam
WHERE c.relname = 'brain_chunks_embedding_idx';

SELECT extname FROM pg_extension WHERE extname IN ('unaccent', 'pg_trgm') ORDER BY extname;

SELECT cfgname FROM pg_ts_config WHERE cfgname = 'portuguese_unaccent';

-- prove the generated column uses the new config (accent-insensitive)
SELECT to_tsvector('portuguese_unaccent', 'reunião sao paulo') @@ to_tsquery('portuguese_unaccent', 'reuniao & são') AS accent_insensitive;
