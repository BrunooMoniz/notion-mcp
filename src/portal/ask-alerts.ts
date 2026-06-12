// src/portal/ask-alerts.ts
// Frente C (#98) — alerta ntfy quando a chamada LLM do /portal/ask falha.
// Throttle de 10 min em memória para não inundar o tópico quando a API da
// Anthropic fica fora (ex.: "credit balance too low"). Clock e notify são
// injetáveis para teste (sem rede, sem sleep).
import { notify } from "../notify.js";

const THROTTLE_MS = 10 * 60 * 1000;

type NotifyFn = typeof notify;

let lastAlertAt = Number.NEGATIVE_INFINITY;
let nowFn: () => number = Date.now;
let notifyFn: NotifyFn = notify;

/** Test-only seam: injeta clock/notify falsos (null restaura e zera o throttle). */
export function __setAlertDepsForTest(
  deps: { now?: () => number; notify?: NotifyFn } | null,
): void {
  nowFn = deps?.now ?? Date.now;
  notifyFn = deps?.notify ?? notify;
  lastAlertAt = Number.NEGATIVE_INFINITY;
}

/**
 * Dispara alerta ntfy de falha de LLM (fire-and-forget, nunca lança).
 * Retorna true quando o alerta saiu, false quando suprimido pelo throttle.
 */
export function alertLlmFailure(context: string, err: unknown): boolean {
  const now = nowFn();
  if (now - lastAlertAt < THROTTLE_MS) return false;
  lastAlertAt = now;
  const msg = err instanceof Error ? err.message : String(err);
  void Promise.resolve(
    notifyFn(`Falha de LLM no /portal/ask (${context}): ${msg}`, {
      title: "Zinom: LLM indisponível",
      priority: "high",
    }),
  ).catch(() => { /* notify já loga; alerta nunca derruba a resposta */ });
  return true;
}
