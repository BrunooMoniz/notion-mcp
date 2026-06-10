// src/admin/__tests__/business.test.ts
// TDD tests for src/admin/business.ts — pure functions only, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFunnel,
  estimateCost,
  engagementOf,
  mrrFromSubscriptions,
  estimateLlmCost,
  summariseCostReport,
  DEFAULT_LLM_IN_PER_MTOK,
  DEFAULT_LLM_OUT_PER_MTOK,
  type FunnelRow,
  type UsageInput,
  type CostEnv,
  type EngagementRow,
  type StripeSub,
  type LlmUsageInput,
  type LlmCostEnv,
  type CostReportResponse,
} from "../business.js";

// ---------------------------------------------------------------------------
// buildFunnel
// ---------------------------------------------------------------------------

test("buildFunnel: returns correct counts and order for all steps", () => {
  const rows: FunnelRow[] = [
    // invites_created  invites_redeemed  has_source  has_search  is_paying
    { invites_created: 10, invites_redeemed: 6, has_source: 4, has_search: 3, is_paying: 1 },
  ];
  const funnel = buildFunnel(rows);

  assert.equal(funnel.length, 5);
  assert.equal(funnel[0].label, "Convites criados");
  assert.equal(funnel[0].count, 10);
  assert.equal(funnel[1].label, "Convites resgatados");
  assert.equal(funnel[1].count, 6);
  assert.equal(funnel[2].label, "Com ≥1 fonte");
  assert.equal(funnel[2].count, 4);
  assert.equal(funnel[3].label, "Com ≥1 busca");
  assert.equal(funnel[3].count, 3);
  assert.equal(funnel[4].label, "Pagantes");
  assert.equal(funnel[4].count, 1);
});

test("buildFunnel: pct is relative to invites_created (first step)", () => {
  const rows: FunnelRow[] = [
    { invites_created: 10, invites_redeemed: 5, has_source: 4, has_search: 2, is_paying: 1 },
  ];
  const funnel = buildFunnel(rows);

  assert.equal(funnel[0].pct, 100);
  assert.equal(funnel[1].pct, 50);
  assert.equal(funnel[2].pct, 40);
  assert.equal(funnel[3].pct, 20);
  assert.equal(funnel[4].pct, 10);
});

test("buildFunnel: handles zero invites_created without division by zero", () => {
  const rows: FunnelRow[] = [
    { invites_created: 0, invites_redeemed: 0, has_source: 0, has_search: 0, is_paying: 0 },
  ];
  const funnel = buildFunnel(rows);
  assert.equal(funnel[0].pct, 0);
  assert.equal(funnel[4].pct, 0);
});

test("buildFunnel: handles empty rows array (all zeros)", () => {
  const funnel = buildFunnel([]);
  assert.equal(funnel.length, 5);
  funnel.forEach((step) => {
    assert.equal(step.count, 0);
    assert.equal(step.pct, 0);
  });
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

test("estimateCost: returns zeros and warning when env vars absent", () => {
  const usage: UsageInput = { embed_tokens: 1_000_000, searches: 100 };
  const env: CostEnv = {};
  const result = estimateCost(usage, env);
  assert.equal(result.embedCost, 0);
  assert.equal(result.searchCost, 0);
  assert.equal(result.totalCost, 0);
  assert.equal(result.missingConfig, true);
});

test("estimateCost: computes correctly when env vars present", () => {
  const usage: UsageInput = { embed_tokens: 2_000_000, searches: 50 };
  const env: CostEnv = { COST_EMBED_PER_MTOK: "0.10", COST_PER_SEARCH: "0.01" };
  const result = estimateCost(usage, env);
  // embed: 2 MTok * 0.10 = 0.20
  // search: 50 * 0.01 = 0.50
  assert.ok(Math.abs(result.embedCost - 0.2) < 0.0001);
  assert.ok(Math.abs(result.searchCost - 0.5) < 0.0001);
  assert.ok(Math.abs(result.totalCost - 0.7) < 0.0001);
  assert.equal(result.missingConfig, false);
});

test("estimateCost: handles zero embed_tokens and searches", () => {
  const usage: UsageInput = { embed_tokens: 0, searches: 0 };
  const env: CostEnv = { COST_EMBED_PER_MTOK: "0.10", COST_PER_SEARCH: "0.01" };
  const result = estimateCost(usage, env);
  assert.equal(result.embedCost, 0);
  assert.equal(result.searchCost, 0);
  assert.equal(result.totalCost, 0);
  assert.equal(result.missingConfig, false);
});

test("estimateCost: partial env (only one var set) still triggers missingConfig", () => {
  const usage: UsageInput = { embed_tokens: 1_000_000, searches: 10 };
  const env: CostEnv = { COST_EMBED_PER_MTOK: "0.10" };
  const result = estimateCost(usage, env);
  assert.equal(result.missingConfig, true);
});

// ---------------------------------------------------------------------------
// engagementOf — boundary tests at exactly 14 days
// ---------------------------------------------------------------------------

test("engagementOf: account with last search 13d 23h ago is NOT dormant", () => {
  const now = new Date("2025-01-15T12:00:00Z");
  // 13d 23h before now = 2025-01-01T13:00:00Z
  const lastSearch = new Date("2025-01-01T13:00:00Z");
  const rows: EngagementRow[] = [
    { account_id: "a1", ts: lastSearch, metric: "search" },
  ];
  const eng = engagementOf(rows, now);
  assert.equal(eng.length, 1);
  assert.equal(eng[0].dormant, false);
});

test("engagementOf: account with last search exactly 14d1h ago IS dormant", () => {
  const now = new Date("2025-01-15T12:00:00Z");
  // 14d 1h before now = 2024-12-31T11:00:00Z (>14d ago)
  const lastSearch = new Date("2024-12-31T11:00:00Z");
  const rows: EngagementRow[] = [
    { account_id: "a1", ts: lastSearch, metric: "search" },
  ];
  const eng = engagementOf(rows, now);
  assert.equal(eng[0].dormant, true);
});

test("engagementOf: account with no historical searches is NOT marked dormant", () => {
  const now = new Date("2025-01-15T12:00:00Z");
  // no search rows for this account
  const eng = engagementOf([], now);
  assert.equal(eng.length, 0);
});

test("engagementOf: account with searches only 30d ago is dormant", () => {
  const now = new Date("2025-01-15T12:00:00Z");
  const lastSearch = new Date("2024-12-16T12:00:00Z"); // 30d ago
  const rows: EngagementRow[] = [
    { account_id: "a1", ts: lastSearch, metric: "search" },
  ];
  const eng = engagementOf(rows, now);
  assert.equal(eng[0].dormant, true);
});

test("engagementOf: computes 7d and 30d search counts correctly", () => {
  const now = new Date("2025-01-15T12:00:00Z");
  const rows: EngagementRow[] = [
    // within 7d
    { account_id: "a1", ts: new Date("2025-01-14T00:00:00Z"), metric: "search" },
    { account_id: "a1", ts: new Date("2025-01-13T00:00:00Z"), metric: "search" },
    // within 30d but not 7d
    { account_id: "a1", ts: new Date("2025-01-01T00:00:00Z"), metric: "search" },
    // beyond 30d (should not count)
    { account_id: "a1", ts: new Date("2024-12-10T00:00:00Z"), metric: "search" },
  ];
  const eng = engagementOf(rows, now);
  assert.equal(eng[0].searches7d, 2);
  assert.equal(eng[0].searches30d, 3);
});

// ---------------------------------------------------------------------------
// mrrFromSubscriptions
// ---------------------------------------------------------------------------

test("mrrFromSubscriptions: sums amount from active subscriptions only", () => {
  const subs: StripeSub[] = [
    { id: "sub_1", status: "active", amount: 999, currency: "brl", current_period_end: 0, customer: "cus_1", account_id: null },
    { id: "sub_2", status: "active", amount: 499, currency: "brl", current_period_end: 0, customer: "cus_2", account_id: null },
    { id: "sub_3", status: "past_due", amount: 1899, currency: "brl", current_period_end: 0, customer: "cus_3", account_id: null },
    { id: "sub_4", status: "canceled", amount: 999, currency: "brl", current_period_end: 0, customer: "cus_4", account_id: null },
  ];
  const { mrrCents, byStatus } = mrrFromSubscriptions(subs);
  // Only active: 999 + 499 = 1498
  assert.equal(mrrCents, 1498);
  assert.equal(byStatus.active, 2);
  assert.equal(byStatus.past_due, 1);
  assert.equal(byStatus.canceled, 1);
});

test("mrrFromSubscriptions: returns 0 MRR for empty list", () => {
  const { mrrCents, byStatus } = mrrFromSubscriptions([]);
  assert.equal(mrrCents, 0);
  assert.equal(byStatus.active, 0);
  assert.equal(byStatus.past_due, 0);
  assert.equal(byStatus.canceled, 0);
});

test("mrrFromSubscriptions: all canceled yields 0 MRR", () => {
  const subs: StripeSub[] = [
    { id: "sub_1", status: "canceled", amount: 999, currency: "brl", current_period_end: 0, customer: "cus_1", account_id: null },
  ];
  const { mrrCents } = mrrFromSubscriptions(subs);
  assert.equal(mrrCents, 0);
});

// ---------------------------------------------------------------------------
// estimateLlmCost (F2)
// ---------------------------------------------------------------------------

test("estimateLlmCost: uses default Haiku 4.5 prices when env vars absent", () => {
  const usage: LlmUsageInput = { llm_input_tokens: 1_000_000, llm_output_tokens: 1_000_000 };
  const env: LlmCostEnv = {};
  const result = estimateLlmCost(usage, env);
  // $1.00/MTok input + $5.00/MTok output
  assert.ok(Math.abs(result.inputCost - DEFAULT_LLM_IN_PER_MTOK) < 0.0001);
  assert.ok(Math.abs(result.outputCost - DEFAULT_LLM_OUT_PER_MTOK) < 0.0001);
  assert.ok(Math.abs(result.totalCost - (DEFAULT_LLM_IN_PER_MTOK + DEFAULT_LLM_OUT_PER_MTOK)) < 0.0001);
});

test("estimateLlmCost: uses overridden env prices", () => {
  const usage: LlmUsageInput = { llm_input_tokens: 2_000_000, llm_output_tokens: 500_000 };
  const env: LlmCostEnv = { COST_LLM_IN_PER_MTOK: "2.00", COST_LLM_OUT_PER_MTOK: "10.00" };
  const result = estimateLlmCost(usage, env);
  // in: 2M * 2.00 = 4.00; out: 0.5M * 10.00 = 5.00; total = 9.00
  assert.ok(Math.abs(result.inputCost - 4.0) < 0.0001);
  assert.ok(Math.abs(result.outputCost - 5.0) < 0.0001);
  assert.ok(Math.abs(result.totalCost - 9.0) < 0.0001);
});

test("estimateLlmCost: zero tokens yields zero costs", () => {
  const usage: LlmUsageInput = { llm_input_tokens: 0, llm_output_tokens: 0 };
  const env: LlmCostEnv = {};
  const result = estimateLlmCost(usage, env);
  assert.equal(result.inputCost, 0);
  assert.equal(result.outputCost, 0);
  assert.equal(result.totalCost, 0);
});

test("estimateLlmCost: default prices match documented Haiku 4.5 pricing", () => {
  // Verify the defaults are the values documented in business.ts comments.
  // Source: https://platform.claude.com/docs/en/docs/about-claude/models/overview
  // Fetched: 2026-06-09
  assert.equal(DEFAULT_LLM_IN_PER_MTOK, 1.0);
  assert.equal(DEFAULT_LLM_OUT_PER_MTOK, 5.0);
});

// ---------------------------------------------------------------------------
// summariseCostReport (F2)
// ---------------------------------------------------------------------------

test("summariseCostReport: sums all amounts across buckets and results", () => {
  const report: CostReportResponse = {
    has_more: false,
    next_page: null,
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "100.00",
            currency: "USD",
            cost_type: "tokens",
            model: "claude-haiku-4-5-20251001",
            token_type: "uncached_input_tokens",
            service_tier: "standard",
            context_window: "0-200k",
            workspace_id: null,
            description: null,
            inference_geo: "global",
          },
          {
            amount: "50.50",
            currency: "USD",
            cost_type: "tokens",
            model: "claude-haiku-4-5-20251001",
            token_type: "output_tokens",
            service_tier: "standard",
            context_window: "0-200k",
            workspace_id: null,
            description: null,
            inference_geo: "global",
          },
        ],
      },
      {
        starting_at: "2026-06-02T00:00:00Z",
        ending_at: "2026-06-03T00:00:00Z",
        results: [
          {
            amount: "25.25",
            currency: "USD",
            cost_type: "tokens",
            model: "claude-haiku-4-5-20251001",
            token_type: "output_tokens",
            service_tier: "standard",
            context_window: "0-200k",
            workspace_id: null,
            description: null,
            inference_geo: "global",
          },
        ],
      },
    ],
  };
  const summary = summariseCostReport(report);
  // 100.00 + 50.50 + 25.25 = 175.75
  assert.ok(Math.abs(summary.totalUsdCents - 175.75) < 0.001);
  assert.equal(summary.buckets, 2);
});

test("summariseCostReport: empty data returns zero", () => {
  const report: CostReportResponse = { data: [], has_more: false, next_page: null };
  const summary = summariseCostReport(report);
  assert.equal(summary.totalUsdCents, 0);
  assert.equal(summary.buckets, 0);
});

test("summariseCostReport: ignores invalid/non-numeric amounts", () => {
  const report: CostReportResponse = {
    has_more: false,
    next_page: null,
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "50.00",
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
            amount: "not-a-number",
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
  };
  const summary = summariseCostReport(report);
  assert.ok(Math.abs(summary.totalUsdCents - 50.0) < 0.001);
});
