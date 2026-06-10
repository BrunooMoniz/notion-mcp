// src/admin/business.ts
// Pure business-logic functions for the admin dashboard (P3).
// All functions are dependency-injected / pure — no DB or Stripe imports here,
// so they are unit-testable without any infrastructure.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row returned by the funnel SQL query (30d window + total). */
export interface FunnelRow {
  invites_created: number;
  invites_redeemed: number;
  has_source: number;
  has_search: number;
  is_paying: number;
}

/** One step of the activation funnel. */
export interface FunnelStep {
  label: string;
  count: number;
  pct: number; // relative to invites_created (top of funnel)
}

/** One row from the usage_log table (filtered to metric='search'). */
export interface EngagementRow {
  account_id: string;
  ts: Date;
  metric: string;
}

/** Per-account engagement summary. */
export interface AccountEngagement {
  account_id: string;
  searches7d: number;
  searches30d: number;
  lastSearch: Date | null;
  dormant: boolean; // has ≥1 historical search but none in the last 14 days
}

/** Minimal shape of a Stripe subscription needed for MRR computation. */
export interface StripeSub {
  id: string;
  status: string; // 'active' | 'past_due' | 'canceled' | ...
  amount: number; // in cents
  currency: string;
  current_period_end: number; // unix seconds
  customer: string;
  account_id: string | null; // metadata.account_id if present
}

/** MRR summary from a list of subscriptions. */
export interface MrrResult {
  mrrCents: number;
  byStatus: Record<string, number>;
}

/** Input for cost estimation. */
export interface UsageInput {
  embed_tokens: number;
  searches: number;
}

/** Env vars for cost estimation (injected for testability). */
export interface CostEnv {
  COST_EMBED_PER_MTOK?: string;
  COST_PER_SEARCH?: string;
}

/** Per-account cost estimate. */
export interface CostEstimate {
  embedCost: number;
  searchCost: number;
  totalCost: number;
  missingConfig: boolean; // true when any env var is absent
}

// ---------------------------------------------------------------------------
// LLM cost estimation (F2)
// ---------------------------------------------------------------------------

/**
 * Input for LLM cost estimation.
 * Tokens are raw counts read from usage_log metrics
 * llm_input_tokens / llm_output_tokens.
 */
export interface LlmUsageInput {
  llm_input_tokens: number;
  llm_output_tokens: number;
}

/**
 * Env vars for LLM cost estimation (injected for testability).
 *
 * Defaults (when env vars absent):
 *   COST_LLM_IN_PER_MTOK  = 1.00   (Claude Haiku 4.5 input, USD/MTok)
 *   COST_LLM_OUT_PER_MTOK = 5.00   (Claude Haiku 4.5 output, USD/MTok)
 *
 * Source: https://platform.claude.com/docs/en/docs/about-claude/models/overview
 * Fetched: 2026-06-09
 * Model in use: claude-haiku-4-5-20251001 (see src/classifier/anthropic.ts and
 * src/portal/ask.ts for CLASSIFIER_MODEL / ASK_MODEL env vars).
 */
export interface LlmCostEnv {
  COST_LLM_IN_PER_MTOK?: string;
  COST_LLM_OUT_PER_MTOK?: string;
}

/** Default prices for Claude Haiku 4.5 (USD per million tokens). */
export const DEFAULT_LLM_IN_PER_MTOK = 1.0;
export const DEFAULT_LLM_OUT_PER_MTOK = 5.0;

/** Per-account LLM cost estimate. */
export interface LlmCostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/**
 * Estimate LLM cost for a single account (current month).
 * Uses env vars with defaults from Claude Haiku 4.5 pricing.
 */
export function estimateLlmCost(usage: LlmUsageInput, env: LlmCostEnv): LlmCostEstimate {
  const inRate =
    env.COST_LLM_IN_PER_MTOK !== undefined
      ? parseFloat(env.COST_LLM_IN_PER_MTOK)
      : DEFAULT_LLM_IN_PER_MTOK;
  const outRate =
    env.COST_LLM_OUT_PER_MTOK !== undefined
      ? parseFloat(env.COST_LLM_OUT_PER_MTOK)
      : DEFAULT_LLM_OUT_PER_MTOK;

  const inputCost = (usage.llm_input_tokens / 1_000_000) * inRate;
  const outputCost = (usage.llm_output_tokens / 1_000_000) * outRate;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

// ---------------------------------------------------------------------------
// Anthropic Admin API cost report (F2)
// ---------------------------------------------------------------------------

/**
 * One time bucket from GET /v1/organizations/cost_report.
 * Source: https://platform.claude.com/docs/en/api/admin/cost_report/retrieve
 * Fetched: 2026-06-09
 */
export interface CostReportBucket {
  starting_at: string; // RFC 3339
  ending_at: string;   // RFC 3339
  results: CostReportResult[];
}

export interface CostReportResult {
  amount: string; // decimal string, in lowest currency units (cents)
  currency: string; // always "USD"
  cost_type: string | null;
  model: string | null;
  token_type: string | null;
  service_tier: string | null;
  context_window: string | null;
  workspace_id: string | null;
  description: string | null;
  inference_geo: string | null;
}

/**
 * Raw response from GET /v1/organizations/cost_report.
 */
export interface CostReportResponse {
  data: CostReportBucket[];
  has_more: boolean;
  next_page: string | null;
}

/**
 * Summarised org-level cost for a period: total USD cents summed across all
 * buckets and result items.
 */
export interface OrgCostSummary {
  totalUsdCents: number;
  buckets: number;
}

/**
 * Sum all `amount` values in a cost report response (USD cents as decimal
 * strings → total cents as a number). Pure — no I/O.
 */
export function summariseCostReport(report: CostReportResponse): OrgCostSummary {
  let total = 0;
  for (const bucket of report.data) {
    for (const result of bucket.results) {
      const v = parseFloat(result.amount);
      if (Number.isFinite(v)) total += v;
    }
  }
  return { totalUsdCents: total, buckets: report.data.length };
}

// ---------------------------------------------------------------------------
// buildFunnel
// ---------------------------------------------------------------------------

/** Build the 5-step activation funnel from a (typically single) aggregated row. */
export function buildFunnel(rows: FunnelRow[]): FunnelStep[] {
  const r = rows[0] ?? { invites_created: 0, invites_redeemed: 0, has_source: 0, has_search: 0, is_paying: 0 };
  const top = r.invites_created;
  const pct = (n: number) => (top === 0 ? 0 : Math.round((n / top) * 100));

  return [
    { label: "Convites criados", count: r.invites_created, pct: pct(r.invites_created) },
    { label: "Convites resgatados", count: r.invites_redeemed, pct: pct(r.invites_redeemed) },
    { label: "Com ≥1 fonte", count: r.has_source, pct: pct(r.has_source) },
    { label: "Com ≥1 busca", count: r.has_search, pct: pct(r.has_search) },
    { label: "Pagantes", count: r.is_paying, pct: pct(r.is_paying) },
  ];
}

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

/** Estimate infrastructure cost for a single account this month. */
export function estimateCost(usage: UsageInput, env: CostEnv): CostEstimate {
  const embedRate = env.COST_EMBED_PER_MTOK !== undefined ? parseFloat(env.COST_EMBED_PER_MTOK) : null;
  const searchRate = env.COST_PER_SEARCH !== undefined ? parseFloat(env.COST_PER_SEARCH) : null;

  const missingConfig = embedRate === null || searchRate === null;

  const embedCost = embedRate !== null ? (usage.embed_tokens / 1_000_000) * embedRate : 0;
  const searchCost = searchRate !== null ? usage.searches * searchRate : 0;

  return {
    embedCost,
    searchCost,
    totalCost: embedCost + searchCost,
    missingConfig,
  };
}

// ---------------------------------------------------------------------------
// engagementOf
// ---------------------------------------------------------------------------

const MS_14D = 14 * 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute per-account engagement from a flat list of usage_log rows (metric=search).
 * `now` is injected so the 14d boundary test is deterministic.
 */
export function engagementOf(rows: EngagementRow[], now: Date): AccountEngagement[] {
  // Group by account
  const byAccount = new Map<string, Date[]>();
  for (const r of rows) {
    if (r.metric !== "search") continue;
    const arr = byAccount.get(r.account_id) ?? [];
    arr.push(r.ts instanceof Date ? r.ts : new Date(r.ts));
    byAccount.set(r.account_id, arr);
  }

  const nowMs = now.getTime();
  const result: AccountEngagement[] = [];

  for (const [account_id, timestamps] of byAccount) {
    const sorted = timestamps.sort((a, b) => b.getTime() - a.getTime());
    const lastSearch = sorted[0] ?? null;
    const searches7d = sorted.filter((t) => nowMs - t.getTime() <= MS_7D).length;
    const searches30d = sorted.filter((t) => nowMs - t.getTime() <= MS_30D).length;
    // Dormant: has ≥1 historical search AND no search within 14d
    const dormant = sorted.length > 0 && (lastSearch === null || nowMs - lastSearch.getTime() > MS_14D);

    result.push({ account_id, searches7d, searches30d, lastSearch, dormant });
  }

  return result;
}

// ---------------------------------------------------------------------------
// mrrFromSubscriptions
// ---------------------------------------------------------------------------

/** Compute MRR from a list of Stripe subscriptions. Only 'active' subs count. */
export function mrrFromSubscriptions(subs: StripeSub[]): MrrResult {
  const byStatus: Record<string, number> = { active: 0, past_due: 0, canceled: 0 };
  let mrrCents = 0;

  for (const sub of subs) {
    const s = sub.status;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (s === "active") {
      mrrCents += sub.amount;
    }
  }

  return { mrrCents, byStatus };
}
