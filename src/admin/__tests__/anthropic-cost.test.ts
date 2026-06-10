// src/admin/__tests__/anthropic-cost.test.ts
// TDD tests for src/admin/anthropic-cost.ts — all network calls mocked.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getOrgCostReport, __resetCostReportCache, type FetchFn } from "../anthropic-cost.js";
import type { CostReportResponse } from "../business.js";

// Reset cache and env before each test.
beforeEach(() => {
  __resetCostReportCache();
  delete process.env.ANTHROPIC_ADMIN_KEY;
});

afterEach(() => {
  __resetCostReportCache();
  delete process.env.ANTHROPIC_ADMIN_KEY;
});

// A minimal valid CostReportResponse for mocking.
function makeReport(overrides: Partial<CostReportResponse> = {}): CostReportResponse {
  return {
    data: [
      {
        starting_at: "2026-06-01T00:00:00Z",
        ending_at: "2026-06-02T00:00:00Z",
        results: [
          {
            amount: "123.45",
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
        ],
      },
    ],
    has_more: false,
    next_page: null,
    ...overrides,
  };
}

// Build a mock fetch that returns the given response.
function mockFetch(report: CostReportResponse, status = 200): FetchFn {
  return async (_url, _init) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => report,
      text: async () => JSON.stringify(report),
    } as Response;
  };
}

test("getOrgCostReport: returns null when ANTHROPIC_ADMIN_KEY is absent", async () => {
  const result = await getOrgCostReport(mockFetch(makeReport()));
  assert.equal(result, null);
});

test("getOrgCostReport: fetches and returns report when key is set", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "test-key";
  const report = makeReport();
  const result = await getOrgCostReport(mockFetch(report));
  assert.ok(result !== null);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].results[0].amount, "123.45");
});

test("getOrgCostReport: uses X-Api-Key header (not Authorization)", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "sk-admin-test";
  let capturedHeaders: Record<string, string> = {};
  const captureFetch: FetchFn = async (_url, init) => {
    capturedHeaders = (init.headers as Record<string, string>) ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => makeReport(),
      text: async () => "",
    } as Response;
  };
  await getOrgCostReport(captureFetch);
  assert.equal(capturedHeaders["X-Api-Key"], "sk-admin-test");
  assert.ok(!("Authorization" in capturedHeaders), "should NOT use Authorization header");
});

test("getOrgCostReport: sends anthropic-version header", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "sk-admin-test";
  let capturedHeaders: Record<string, string> = {};
  const captureFetch: FetchFn = async (_url, init) => {
    capturedHeaders = (init.headers as Record<string, string>) ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => makeReport(),
      text: async () => "",
    } as Response;
  };
  await getOrgCostReport(captureFetch);
  assert.ok(capturedHeaders["anthropic-version"], "anthropic-version header required");
});

test("getOrgCostReport: returns cached result within 1h (no second fetch)", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "test-key";
  let fetchCallCount = 0;
  const countingFetch: FetchFn = async (_url, _init) => {
    fetchCallCount++;
    return {
      ok: true,
      status: 200,
      json: async () => makeReport(),
      text: async () => "",
    } as Response;
  };
  await getOrgCostReport(countingFetch);
  await getOrgCostReport(countingFetch);
  assert.equal(fetchCallCount, 1, "second call should use cache");
});

test("getOrgCostReport: throws on non-2xx response", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "test-key";
  const errorFetch: FetchFn = async (_url, _init) => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => "Unauthorized",
  } as Response);
  await assert.rejects(
    () => getOrgCostReport(errorFetch),
    /401/,
  );
});

test("getOrgCostReport: paginates until has_more=false", async () => {
  process.env.ANTHROPIC_ADMIN_KEY = "test-key";
  let callCount = 0;
  const pagingFetch: FetchFn = async (_url, _init) => {
    callCount++;
    const isFirst = callCount === 1;
    const resp: CostReportResponse = {
      data: [
        {
          starting_at: `2026-06-0${callCount}T00:00:00Z`,
          ending_at: `2026-06-0${callCount + 1}T00:00:00Z`,
          results: [{ amount: "10.00", currency: "USD", cost_type: null, model: null, token_type: null, service_tier: null, context_window: null, workspace_id: null, description: null, inference_geo: null }],
        },
      ],
      has_more: isFirst,
      next_page: isFirst ? "page2-token" : null,
    };
    return { ok: true, status: 200, json: async () => resp, text: async () => "" } as Response;
  };
  const result = await getOrgCostReport(pagingFetch);
  assert.equal(callCount, 2, "should have made 2 requests (page 1 + page 2)");
  assert.equal(result!.data.length, 2, "should accumulate buckets from both pages");
});
