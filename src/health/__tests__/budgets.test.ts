// src/health/__tests__/budgets.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { evalBudget, voyageSpentUsd, anthropicBudgetCheck } from "../budgets.js";
import type { CostReportResponse } from "../../admin/business.js";

// ---------------------------------------------------------------------------
// voyageSpentUsd — aritmética pura (importação estática usada nos testes)
// ---------------------------------------------------------------------------

test("voyageSpentUsd: 1M tokens × $0.12/MTok = $0.12", () => {
  assert.strictEqual(voyageSpentUsd(1_000_000, 0.12), 0.12);
});

test("voyageSpentUsd: 500k tokens × $0.12/MTok = $0.06", () => {
  assert.ok(Math.abs(voyageSpentUsd(500_000, 0.12) - 0.06) < 1e-12);
});

test("voyageSpentUsd: 0 tokens → $0", () => {
  assert.strictEqual(voyageSpentUsd(0, 0.12), 0);
});

// ---------------------------------------------------------------------------
// evalBudget — limiares exatos
// ---------------------------------------------------------------------------

test("evalBudget: sem orçamento (undefined) → ok", () => {
  assert.strictEqual(evalBudget(50, undefined), "ok");
});

test("evalBudget: 0% gasto → ok", () => {
  assert.strictEqual(evalBudget(0, 100), "ok");
});

test("evalBudget: 79.9% (abaixo de 80) → ok", () => {
  assert.strictEqual(evalBudget(79.9, 100), "ok");
});

test("evalBudget: 80% (exato) → warn", () => {
  assert.strictEqual(evalBudget(80, 100), "warn");
});

test("evalBudget: 99.9% → warn", () => {
  assert.strictEqual(evalBudget(99.9, 100), "warn");
});

test("evalBudget: 100% (exato) → fail", () => {
  assert.strictEqual(evalBudget(100, 100), "fail");
});

test("evalBudget: 150% (acima de 100) → fail", () => {
  assert.strictEqual(evalBudget(150, 100), "fail");
});

test("evalBudget: orçamento zero, gasto zero → fail (pct=0/0 → 100)", () => {
  // pct = 0/0 = NaN → tratado como 0, que é < 80 → ok? Não: divisão 0/0 = NaN.
  // Comportamento esperado: sem divisão segura → orçamento zero com gasto zero é fail (limite atingido).
  // Vamos checar o comportamento: budgetUsd=0 → pct = spent/0*100 = Infinity → fail
  assert.strictEqual(evalBudget(0, 0), "fail");
});


// ---------------------------------------------------------------------------
// anthropicBudgetCheck — getReport injetável
// ---------------------------------------------------------------------------

test("anthropicBudgetCheck: getReport retorna null → skip", async () => {
  const results = await anthropicBudgetCheck(async () => null);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.checkId, "budget:anthropic");
  assert.strictEqual(r.status, "skip");
  assert.strictEqual(r.group, "creditos");
  assert.ok(r.error?.includes("ANTHROPIC_ADMIN_KEY"));
});

test("anthropicBudgetCheck: report com buckets, sem env budget → ok (informacional)", async () => {
  // Fixture: 5000 cents = $50 gasto
  const fakeReport: CostReportResponse = {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "3000",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
          {
            amount: "2000",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };

  delete process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  const results = await anthropicBudgetCheck(async () => fakeReport);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.checkId, "budget:anthropic");
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.group, "creditos");
  assert.strictEqual(r.label, "Crédito Anthropic (mês)");
  // spentUsd = 5000 cents / 100 = $50
  assert.strictEqual((r.detail as Record<string, unknown>).spentUsd, 50);
  assert.strictEqual((r.detail as Record<string, unknown>).budgetUsd, null);
  assert.strictEqual((r.detail as Record<string, unknown>).pct, null);
});

test("anthropicBudgetCheck: report $50 gasto, budget $100 → ok (50%)", async () => {
  const fakeReport: CostReportResponse = {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "5000",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };

  const prev = process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  process.env.HEALTH_BUDGET_ANTHROPIC_USD = "100";
  try {
    const results = await anthropicBudgetCheck(async () => fakeReport);
    const r = results[0];
    assert.strictEqual(r.status, "ok");
    assert.strictEqual((r.detail as Record<string, unknown>).spentUsd, 50);
    assert.strictEqual((r.detail as Record<string, unknown>).budgetUsd, 100);
    assert.strictEqual((r.detail as Record<string, unknown>).pct, 50.0);
  } finally {
    if (prev === undefined) delete process.env.HEALTH_BUDGET_ANTHROPIC_USD;
    else process.env.HEALTH_BUDGET_ANTHROPIC_USD = prev;
  }
});

test("anthropicBudgetCheck: report $82 gasto, budget $100 → warn (82%)", async () => {
  const fakeReport: CostReportResponse = {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "8200",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };

  const prev = process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  process.env.HEALTH_BUDGET_ANTHROPIC_USD = "100";
  try {
    const results = await anthropicBudgetCheck(async () => fakeReport);
    assert.strictEqual(results[0].status, "warn");
    assert.strictEqual((results[0].detail as Record<string, unknown>).pct, 82.0);
  } finally {
    if (prev === undefined) delete process.env.HEALTH_BUDGET_ANTHROPIC_USD;
    else process.env.HEALTH_BUDGET_ANTHROPIC_USD = prev;
  }
});

test("anthropicBudgetCheck: report $101 gasto, budget $100 → fail (101%)", async () => {
  const fakeReport: CostReportResponse = {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "10100",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };

  const prev = process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  process.env.HEALTH_BUDGET_ANTHROPIC_USD = "100";
  try {
    const results = await anthropicBudgetCheck(async () => fakeReport);
    assert.strictEqual(results[0].status, "fail");
  } finally {
    if (prev === undefined) delete process.env.HEALTH_BUDGET_ANTHROPIC_USD;
    else process.env.HEALTH_BUDGET_ANTHROPIC_USD = prev;
  }
});

test("anthropicBudgetCheck: getReport lança exceção → fail com erro truncado (max 200 chars)", async () => {
  const longMsg = "X".repeat(500);
  const results = await anthropicBudgetCheck(async () => {
    throw new Error(longMsg);
  });
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.checkId, "budget:anthropic");
  assert.strictEqual(r.status, "fail");
  assert.ok(typeof r.error === "string");
  assert.ok(r.error.length <= 200);
});

test("anthropicBudgetCheck: pct arredondado a 1 casa decimal", async () => {
  // $1 gasto, $3 budget → 33.333...% → deve ser 33.3
  const fakeReport: CostReportResponse = {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "100",
            currency: "USD",
            cost_type: null,
            model: null,
            token_type: null,
            service_tier: null,
            context_window: null,
            workspace_id: null,
            description: null,
            inference_geo: null,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };

  const prev = process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  process.env.HEALTH_BUDGET_ANTHROPIC_USD = "3";
  try {
    const results = await anthropicBudgetCheck(async () => fakeReport);
    const pct = (results[0].detail as Record<string, unknown>).pct as number;
    // 1/3*100 = 33.333... → 33.3
    assert.strictEqual(pct, 33.3);
  } finally {
    if (prev === undefined) delete process.env.HEALTH_BUDGET_ANTHROPIC_USD;
    else process.env.HEALTH_BUDGET_ANTHROPIC_USD = prev;
  }
});
