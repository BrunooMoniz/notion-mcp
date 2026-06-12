// src/health/storage.ts
// Shell fino de SQL para health_samples (migration 0017). Sem lógica de
// negócio aqui — avaliação de estado vive nos probes; agregação na UI.
import { getPool } from "../rag/storage.js";
import type { CheckResult, HealthStatus } from "./types.js";

export interface SampleRow {
  check_id: string;
  ts: Date;
  status: HealthStatus;
  latency_ms: number | null;
  /** Inclui label/group gravados no insert, para a UI renderizar sem registry. */
  detail: Record<string, unknown> | null;
  error: string | null;
}

export interface SeriesPoint {
  check_id: string;
  ts: Date;
  latency_ms: number | null;
  detail: Record<string, unknown> | null;
}

/** Grava uma linha por check. label/group entram em detail; error trunca a 200. */
export async function insertSamples(results: CheckResult[], now: Date = new Date()): Promise<void> {
  if (!results.length) return;
  const tuples: string[] = [];
  const values: unknown[] = [];
  results.forEach((r, i) => {
    const o = i * 6;
    tuples.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
    values.push(
      r.checkId,
      now,
      r.status,
      r.latencyMs ?? null,
      JSON.stringify({ ...(r.detail ?? {}), label: r.label, group: r.group }),
      r.error ? r.error.slice(0, 200) : null,
    );
  });
  await getPool().query(
    `INSERT INTO health_samples (check_id, ts, status, latency_ms, detail, error) VALUES ${tuples.join(",")}`,
    values,
  );
}

/** Última amostra de cada check. */
export async function latestSamples(): Promise<SampleRow[]> {
  const res = await getPool().query<SampleRow>(
    `SELECT DISTINCT ON (check_id) check_id, ts, status, latency_ms, detail, error
     FROM health_samples ORDER BY check_id, ts DESC`,
  );
  return res.rows;
}

/** Mapa check_id → status da última amostra (para detectar transições). */
export async function latestStatuses(): Promise<Map<string, HealthStatus>> {
  const rows = await latestSamples();
  return new Map(rows.map((r) => [r.check_id, r.status]));
}

/** Série crua das últimas `hours` horas, ordenada por ts asc (para sparklines). */
export async function seriesSince(hours: number, now: Date = new Date()): Promise<SeriesPoint[]> {
  const from = new Date(now.getTime() - hours * 3600_000);
  const res = await getPool().query<SeriesPoint>(
    `SELECT check_id, ts, latency_ms, detail FROM health_samples
     WHERE ts >= $1 ORDER BY ts ASC`,
    [from],
  );
  return res.rows;
}

/** Apaga amostras com mais de `days` dias. */
export async function pruneSamples(days: number, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - days * 24 * 3600_000);
  await getPool().query(`DELETE FROM health_samples WHERE ts < $1`, [cutoff]);
}

/**
 * Amostras de HOJE (UTC) anteriores a `now`, restritas a checkIds.
 * Usada pelos alertas de orçamento (máx. 1 alerta por limiar por dia).
 */
export async function samplesToday(checkIds: string[], now: Date = new Date()): Promise<SampleRow[]> {
  if (!checkIds.length) return [];
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const res = await getPool().query<SampleRow>(
    `SELECT check_id, ts, status, latency_ms, detail, error FROM health_samples
     WHERE check_id = ANY($1) AND ts >= $2 AND ts < $3 ORDER BY ts ASC`,
    [checkIds, dayStart, now],
  );
  return res.rows;
}
