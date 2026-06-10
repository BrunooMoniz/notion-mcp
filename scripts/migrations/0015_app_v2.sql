-- 0015_app_v2.sql
-- 002-app-v2 — backend for the logged-in area v2. Additive and idempotent.
-- ai_search_log: per-account transparency log of what the connected AIs
-- searched ("O que sua IA buscou" card). Query text is truncated to 300 chars
-- at write time (recordSearchEvent); rows belong to ONE account only.
CREATE TABLE IF NOT EXISTS ai_search_log (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  query       text NOT NULL,
  results     int NOT NULL,
  client      text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_search_log_acct_ts_idx ON ai_search_log (account_id, ts DESC);

-- portal_sessions.user_agent: shown in the "Sessões ativas" list so the user
-- can recognize (and revoke) their own devices.
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS user_agent text;

-- Indexes for the app-v2 card queries (additive, idempotent):
-- "Sua semana" / recent-documents scans filter by account and order by recency.
CREATE INDEX IF NOT EXISTS brain_chunks_acct_indexed_idx
  ON brain_chunks (account_id, indexed_at DESC);
-- "Próxima reunião": calendar chunks narrowed by account + event-date prefix
-- (left(metadata->>'data',10) is exactly the expression getNextMeeting filters
-- and orders by). Partial on source_type='calendar' keeps it tiny.
CREATE INDEX IF NOT EXISTS brain_chunks_acct_calendar_data_idx
  ON brain_chunks (account_id, (left(metadata->>'data', 10)))
  WHERE source_type = 'calendar';
