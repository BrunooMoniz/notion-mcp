// src/health/alerts.ts
// STUB (T0): contrato fixado para o collector compilar; a implementação real
// (transições ok→fail / fail→ok e limiares de orçamento, via notify/ntfy) é a
// tarefa TE do plano docs/superpowers/plans/2026-06-11-admin-health-dashboard.md.
import type { CheckResult, HealthStatus } from "./types.js";

export interface HealthAlert {
  message: string;
  priority: "default" | "high";
}

export async function dispatchHealthAlerts(
  _prev: Map<string, HealthStatus>,
  _results: CheckResult[],
  _now: Date,
): Promise<void> {
  // no-op até TE
}
