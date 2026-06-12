// src/health/collector.ts
// Orquestra a coleta de saúde: roda todos os probes registrados em paralelo,
// grava as amostras, dispara alertas de transição e poda o histórico (>7d).
// Roda no processo notion-mcp (mesmo do /admin) via HEALTH_CRON, na subida do
// servidor (após 30s) e sob demanda pelo botão "Atualizar agora" do admin.
import cron from "node-cron";
import type { CheckResult, Probe } from "./types.js";
import { insertSamples, latestStatuses, pruneSamples } from "./storage.js";
import { dispatchHealthAlerts } from "./alerts.js";

const RETENTION_DAYS = 7;

const probes: Probe[] = [];

export function registerProbe(p: Probe): void {
  probes.push(p);
}

/** Test seam: zera o registry. */
export function __resetProbesForTest(): void {
  probes.length = 0;
}

let running = false;

/**
 * Uma coleta completa. Idempotente; lock em memória contra execução
 * concorrente (cron + botão "Atualizar agora"): a segunda chamada retorna [].
 * Falha de um probe vira um check "collector" fail — nunca derruba a coleta.
 */
export async function runHealthCollection(now: Date = new Date()): Promise<CheckResult[]> {
  if (running) return [];
  running = true;
  try {
    const settled = await Promise.allSettled(probes.map((p) => p()));
    const results: CheckResult[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(...s.value);
      } else {
        results.push({
          checkId: "collector",
          label: "Collector",
          group: "vps",
          status: "fail",
          error: String(s.reason).slice(0, 200),
        });
      }
    }
    if (!results.length) return results;
    const prev = await latestStatuses();
    await insertSamples(results, now);
    await dispatchHealthAlerts(prev, results, now);
    await pruneSamples(RETENTION_DAYS, now);
    return results;
  } finally {
    running = false;
  }
}

/**
 * Agenda a coleta periódica (HEALTH_CRON, default a cada 5 min; "off" ou vazio
 * desliga) e dispara uma coleta inicial 30s após a subida.
 */
export function startHealthCollector(): void {
  const expr = process.env.HEALTH_CRON ?? "*/5 * * * *";
  if (!expr || expr === "off") return;
  cron.schedule(expr, () => {
    runHealthCollection().catch((err) => console.error(`[health] coleta falhou: ${String(err)}`));
  });
  setTimeout(() => {
    runHealthCollection().catch((err) => console.error(`[health] coleta inicial falhou: ${String(err)}`));
  }, 30_000).unref();
  console.log(`[health] collector agendado (${expr})`);
}
