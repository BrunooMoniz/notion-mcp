// src/health/types.ts
// Contrato do painel de saúde (admin → Sistema). Tipos puros + worstStatus,
// sem I/O, para que probes, collector, alertas e UI compartilhem o mesmo shape.
// Spec: docs/superpowers/specs/2026-06-11-admin-health-dashboard-design.md

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export type HealthGroup =
  | "vps"
  | "processos"
  | "banco"
  | "entrada"
  | "parceiros"
  | "creditos";

export interface CheckResult {
  /** Identificador estável, ex.: "vps", "notion:personal", "budget:anthropic". */
  checkId: string;
  /** Nome de exibição em pt-BR, ex.: "Notion (personal)". */
  label: string;
  group: HealthGroup;
  status: HealthStatus;
  latencyMs?: number;
  /** Números para gauges/barras (diskPct, memPct, spentUsd, budgetUsd…). Nunca segredos. */
  detail?: Record<string, unknown>;
  /** Mensagem de erro truncada; nunca corpo de resposta de parceiro. */
  error?: string;
}

/** Um probe pode emitir vários checks (ex.: um por workspace Notion). */
export type Probe = () => Promise<CheckResult[]>;

const ORDER: Record<HealthStatus, number> = { fail: 3, warn: 2, ok: 1, skip: 0 };

/** Pior estado entre os checks; lista vazia ou tudo-skip → "skip". */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((w, s) => (ORDER[s] > ORDER[w] ? s : w), "skip");
}
