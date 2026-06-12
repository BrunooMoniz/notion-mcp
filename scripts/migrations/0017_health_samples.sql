-- 0017: painel de saúde do sistema (admin → Sistema).
-- Uma linha por check por coleta do collector (HEALTH_CRON, default 5 min).
-- Retenção curta: o collector apaga amostras com mais de 7 dias a cada coleta.
CREATE TABLE IF NOT EXISTS health_samples (
  id         bigserial PRIMARY KEY,
  check_id   text        NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  status     text        NOT NULL CHECK (status IN ('ok','warn','fail','skip')),
  latency_ms integer,
  detail     jsonb,
  error      text
);

CREATE INDEX IF NOT EXISTS idx_health_samples_check_ts
  ON health_samples (check_id, ts DESC);
