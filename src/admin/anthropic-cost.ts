// src/admin/anthropic-cost.ts
// F2 — Client for the Anthropic Admin API cost report.
//
// Endpoint: GET /v1/organizations/cost_report
// Auth:     X-Api-Key: $ANTHROPIC_ADMIN_KEY (separate from ANTHROPIC_API_KEY)
// Source:   https://platform.claude.com/docs/en/api/admin/cost_report/retrieve
// Fetched:  2026-06-09
//
// Behaviour:
//   - When ANTHROPIC_ADMIN_KEY is absent → returns null (caller hides the card).
//   - Fetches the current calendar month (UTC) with bucket_width=1d.
//   - Paginates until has_more=false.
//   - Caches the result in memory for 1 hour.
//   - All network errors are caught and re-thrown so the caller can decide.
import type { CostReportResponse, CostReportBucket } from "./business.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// ---------------------------------------------------------------------------
// In-memory cache (1 hour TTL)
// ---------------------------------------------------------------------------

interface CostReportCache {
  report: CostReportResponse;
  fetchedAt: number; // Date.now()
}
let cache: CostReportCache | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Wipe the cache (test helper). */
export function __resetCostReportCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Fetcher (injectable for tests)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch one page of the cost report. Returns the raw JSON body.
 * Throws on non-2xx.
 */
async function fetchOnePage(
  adminKey: string,
  params: Record<string, string>,
  fetchImpl: FetchFn,
): Promise<CostReportResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${ANTHROPIC_API_BASE}/v1/organizations/cost_report?${qs}`;
  const resp = await fetchImpl(url, {
    headers: {
      "X-Api-Key": adminKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic cost report API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<CostReportResponse>;
}

/**
 * Fetch all pages for the given month, accumulating buckets.
 */
async function fetchAllPages(
  adminKey: string,
  startingAt: string,
  endingAt: string,
  fetchImpl: FetchFn,
): Promise<CostReportResponse> {
  const allBuckets: CostReportBucket[] = [];
  let page: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const params: Record<string, string> = {
      starting_at: startingAt,
      ending_at: endingAt,
      bucket_width: "1d",
    };
    if (page) params.page = page;

    const resp = await fetchOnePage(adminKey, params, fetchImpl);
    allBuckets.push(...resp.data);
    hasMore = resp.has_more;
    page = resp.next_page ?? undefined;
  }

  return { data: allBuckets, has_more: false, next_page: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch (or return from 1h cache) the Anthropic org cost report for the
 * current UTC calendar month.
 *
 * Returns null when ANTHROPIC_ADMIN_KEY is not set (so the UI can hide the
 * card silently, without any error).
 *
 * `fetchImpl` is injectable for tests — defaults to the global `fetch`.
 */
export async function getOrgCostReport(
  fetchImpl: FetchFn = fetch,
): Promise<CostReportResponse | null> {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) return null;

  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.report;
  }

  const nowDate = new Date(now);
  const startingAt = new Date(
    Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1),
  ).toISOString();
  // ending_at = start of next month (exclusive upper bound)
  const endingAt = new Date(
    Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1),
  ).toISOString();

  const report = await fetchAllPages(adminKey, startingAt, endingAt, fetchImpl);
  cache = { report, fetchedAt: now };
  return report;
}
