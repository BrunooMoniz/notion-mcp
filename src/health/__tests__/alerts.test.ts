// src/health/__tests__/alerts.test.ts
// Testes unitários puros (sem DB) de computeTransitionAlerts e computeBudgetAlerts.
// dispatchHealthAlerts é um shell fino (samplesToday + notify) — não testado aqui.
import { test } from "node:test";
import assert from "node:assert";
import { computeTransitionAlerts, computeBudgetAlerts } from "../alerts.js";
import type { CheckResult } from "../types.js";
import type { SampleRow } from "../storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(
  checkId: string,
  status: CheckResult["status"],
  label = checkId,
  error?: string,
): CheckResult {
  return { checkId, label, group: "vps", status, error };
}

function makeRow(
  check_id: string,
  status: SampleRow["status"],
  ts = new Date(),
): SampleRow {
  return { check_id, ts, status, latency_ms: null, detail: null, error: null };
}

// ---------------------------------------------------------------------------
// computeTransitionAlerts
// ---------------------------------------------------------------------------

test("computeTransitionAlerts: ok→fail gera alerta high", () => {
  const prev = new Map([["vps", "ok" as const]]);
  const results = [makeCheck("vps", "fail", "VPS", "disco cheio")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].priority, "high");
  assert.match(alerts[0].message, /✗/);
  assert.match(alerts[0].message, /VPS/);
  assert.match(alerts[0].message, /disco cheio/);
});

test("computeTransitionAlerts: warn→fail gera alerta high", () => {
  const prev = new Map([["vps", "warn" as const]]);
  const results = [makeCheck("vps", "fail", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].priority, "high");
});

test("computeTransitionAlerts: fail→fail NÃO gera alerta", () => {
  const prev = new Map([["vps", "fail" as const]]);
  const results = [makeCheck("vps", "fail", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: fail→ok gera alerta default (recuperação)", () => {
  const prev = new Map([["vps", "fail" as const]]);
  const results = [makeCheck("vps", "ok", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].priority, "default");
  assert.match(alerts[0].message, /✓/);
  assert.match(alerts[0].message, /VPS/);
  assert.match(alerts[0].message, /recuperou/);
});

test("computeTransitionAlerts: ok→warn NÃO gera alerta", () => {
  const prev = new Map([["vps", "ok" as const]]);
  const results = [makeCheck("vps", "warn", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: skip antes nunca alerta", () => {
  const prev = new Map([["vps", "skip" as const]]);
  const results = [makeCheck("vps", "fail", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: skip depois nunca alerta", () => {
  const prev = new Map([["vps", "ok" as const]]);
  const results = [makeCheck("vps", "skip", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: check sem prev nunca alerta", () => {
  const prev = new Map<string, "ok" | "warn" | "fail" | "skip">();
  const results = [makeCheck("vps", "fail", "VPS")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: checks budget:* são excluídos", () => {
  const prev = new Map([["budget:anthropic", "ok" as const]]);
  const results = [makeCheck("budget:anthropic", "fail", "Anthropic budget")];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 0);
});

test("computeTransitionAlerts: erro trunca a 120 chars", () => {
  const longError = "x".repeat(200);
  const prev = new Map([["vps", "ok" as const]]);
  const results = [makeCheck("vps", "fail", "VPS", longError)];
  const alerts = computeTransitionAlerts(prev, results);
  assert.strictEqual(alerts.length, 1);
  // mensagem não deve conter o erro completo (200 chars)
  assert.ok(alerts[0].message.length < 200);
});

// ---------------------------------------------------------------------------
// computeBudgetAlerts
// ---------------------------------------------------------------------------

test("computeBudgetAlerts: warn sem histórico hoje → 1 alerta high", () => {
  const results = [makeCheck("budget:anthropic", "warn", "Anthropic")];
  const alerts = computeBudgetAlerts(results, []);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].priority, "high");
  assert.match(alerts[0].message, /⚠/);
  assert.match(alerts[0].message, /Anthropic/);
  assert.match(alerts[0].message, /80%/);
});

test("computeBudgetAlerts: warn com warn anterior hoje → 0 alertas", () => {
  const results = [makeCheck("budget:anthropic", "warn", "Anthropic")];
  const history = [makeRow("budget:anthropic", "warn")];
  const alerts = computeBudgetAlerts(results, history);
  assert.strictEqual(alerts.length, 0);
});

test("computeBudgetAlerts: fail com apenas warn anterior hoje → 1 alerta (limiar diferente)", () => {
  const results = [makeCheck("budget:anthropic", "fail", "Anthropic")];
  const history = [makeRow("budget:anthropic", "warn")]; // só warn, sem fail
  const alerts = computeBudgetAlerts(results, history);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].priority, "high");
  assert.match(alerts[0].message, /✗/);
  assert.match(alerts[0].message, /estourou/);
});

test("computeBudgetAlerts: fail com fail anterior hoje → 0 alertas", () => {
  const results = [makeCheck("budget:anthropic", "fail", "Anthropic")];
  const history = [makeRow("budget:anthropic", "fail")];
  const alerts = computeBudgetAlerts(results, history);
  assert.strictEqual(alerts.length, 0);
});

test("computeBudgetAlerts: check não-budget ignorado", () => {
  const results = [makeCheck("vps", "warn", "VPS")];
  const alerts = computeBudgetAlerts(results, []);
  assert.strictEqual(alerts.length, 0);
});
