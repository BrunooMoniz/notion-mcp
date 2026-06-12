// src/health/alerts.ts
// Alertas de transição de estado e de orçamento de IA para o painel de saúde.
// Chama notify() (ntfy); sem NTFY_URL vira no-op — nunca lança.
import type { CheckResult, HealthStatus } from "./types.js";
import type { SampleRow } from "./storage.js";
import { samplesToday } from "./storage.js";
import { notify } from "../notify.js";

export interface HealthAlert {
  message: string;
  priority: "default" | "high";
}

/**
 * Detecta transições de estado relevantes e retorna alertas.
 * Regras:
 *   ok|warn → fail : high  "✗ <label> falhou: <erro>"
 *   fail    → ok   : default "✓ <label> recuperou"
 * Ignora:
 *   - checks com prefixo "budget:" (tratados por computeBudgetAlerts)
 *   - prev == skip OU atual == skip
 *   - checks sem entrada em prev (primeira coleta)
 *   - transições que não são os dois casos acima
 */
export function computeTransitionAlerts(
  prev: Map<string, HealthStatus>,
  results: CheckResult[],
): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  for (const r of results) {
    // Budget checks ficam fora desta função
    if (r.checkId.startsWith("budget:")) continue;

    const prevStatus = prev.get(r.checkId);
    // Sem histórico anterior: não alerta (primeira coleta do check)
    if (prevStatus === undefined) continue;

    // Skip em qualquer lado: sem alerta
    if (prevStatus === "skip" || r.status === "skip") continue;

    if ((prevStatus === "ok" || prevStatus === "warn") && r.status === "fail") {
      const rawError = r.error ?? "sem detalhe";
      const erro = rawError.slice(0, 120);
      alerts.push({
        message: `✗ ${r.label} falhou: ${erro}`,
        priority: "high",
      });
    } else if (prevStatus === "fail" && r.status === "ok") {
      alerts.push({
        message: `✓ ${r.label} recuperou`,
        priority: "default",
      });
    }
  }

  return alerts;
}

/**
 * Verifica limiares de orçamento diários para checks "budget:*".
 * Regras (1 alerta por limiar por dia):
 *   warn sem nenhum warn|fail anterior hoje → high "⚠ <label> passou de 80% do orçamento"
 *   fail sem nenhum fail anterior hoje      → high "✗ <label> estourou o orçamento"
 * Checks não-budget são ignorados.
 */
export function computeBudgetAlerts(
  results: CheckResult[],
  todaysEarlier: SampleRow[],
): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  for (const r of results) {
    if (!r.checkId.startsWith("budget:")) continue;

    const history = todaysEarlier.filter((s) => s.check_id === r.checkId);

    if (r.status === "warn") {
      // Alerta só se não houve nenhum warn ou fail hoje antes
      const hadWarnOrFail = history.some((s) => s.status === "warn" || s.status === "fail");
      if (!hadWarnOrFail) {
        alerts.push({
          message: `⚠ ${r.label} passou de 80% do orçamento`,
          priority: "high",
        });
      }
    } else if (r.status === "fail") {
      // Alerta só se não houve fail hoje antes (warn anterior não impede)
      const hadFail = history.some((s) => s.status === "fail");
      if (!hadFail) {
        alerts.push({
          message: `✗ ${r.label} estourou o orçamento`,
          priority: "high",
        });
      }
    }
  }

  return alerts;
}

/**
 * Orquestra os dois cálculos e despacha via notify().
 * Busca amostras de hoje para checks budget:* antes de calcular.
 * Falha de notify não propaga (notify já engole).
 */
export async function dispatchHealthAlerts(
  prev: Map<string, HealthStatus>,
  results: CheckResult[],
  now: Date,
): Promise<void> {
  const budgetCheckIds = results
    .filter((r) => r.checkId.startsWith("budget:"))
    .map((r) => r.checkId);

  const todaysRows = await samplesToday(budgetCheckIds, now);

  const transitionAlerts = computeTransitionAlerts(prev, results);
  const budgetAlerts = computeBudgetAlerts(results, todaysRows);
  const allAlerts = [...transitionAlerts, ...budgetAlerts];

  for (const alert of allAlerts) {
    await notify(alert.message, { title: "Zinom saúde", priority: alert.priority });
  }
}
