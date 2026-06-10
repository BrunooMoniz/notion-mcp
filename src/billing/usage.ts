// src/billing/usage.ts
// Usage queries + quota enforcement on top of the existing passive metering
// (usage_log). The owner/default account is always exempt (fast path, no DB):
// DEFAULT_ACCOUNT_ID is Bruno, and every cron/eval/test context resolves to it,
// so existing behavior and tests are unchanged. Quota breaches THROW a typed
// error (never swallowed) — the caller surfaces a clear PT-BR message.
//
// F7 — Credit enforcement with three modes (env PLAN_ENFORCEMENT):
//   off  — no credit check (legacy behaviour, no DB query).
//   soft — allows the request but logs the excess (DEFAULT). No account blocked.
//   hard — blocks with QuotaExceededError when credits are exhausted.
//
// The "ilimitado" plan is NEVER hard-blocked by credits (only soft-alert).
// The owner/default account is NEVER blocked regardless of mode.
import { getPool, hasInjectedPool } from "../rag/storage.js";
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { getAccountPlan } from "./account-plan.js";
import { getPlanLimits, isUnlimited, UNLIMITED, type PlanFeatures } from "./plans.js";
import { monthlyCreditsUsed } from "./credits.js";

export class QuotaExceededError extends Error {
  constructor(
    public readonly metric: string,
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`Limite do plano atingido (${metric}): ${used}/${limit}. Faça upgrade em zinom.ai/app.html para continuar.`);
    this.name = "QuotaExceededError";
  }
}

export class WorkspaceLimitError extends Error {
  constructor(public readonly limit: number, public readonly current: number) {
    super(`Limite de workspaces do plano atingido (${current}/${limit}). Faça upgrade em zinom.ai/app.html para conectar mais.`);
    this.name = "WorkspaceLimitError";
  }
}

export function monthStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function dayStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// F7 — Enforcement mode
// ---------------------------------------------------------------------------

export type EnforcementMode = "off" | "soft" | "hard";

/** Read PLAN_ENFORCEMENT env var. Defaults to "soft" (never blocks real accounts). */
export function getEnforcementMode(): EnforcementMode {
  const v = (process.env.PLAN_ENFORCEMENT ?? "soft").toLowerCase();
  if (v === "off" || v === "hard") return v;
  return "soft";
}

// ---------------------------------------------------------------------------
// F7 — Credit enforcement gate (called from search, ask, action paths)
// ---------------------------------------------------------------------------

/**
 * Check credit quota for an account. Behaviour by mode:
 *   off  → no-op (no DB query, no log).
 *   soft → logs excess to console; does NOT throw.
 *   hard → throws QuotaExceededError when credits exhausted.
 *          Exception: "ilimitado" plan is never hard-blocked (only soft-alert).
 *
 * Owner/default account is never checked regardless of mode.
 *
 * @param accountId  The account to check.
 * @param metric     A label for logging (e.g. "search", "ask", "action").
 * @param creditCost How many credits this operation costs (used for pre-check in hard mode).
 */
export async function assertCreditsWithinLimit(
  accountId: string,
  metric: string,
  creditCost: number,
): Promise<void> {
  // Owner/default is always exempt.
  if (accountId === DEFAULT_ACCOUNT_ID) return;

  const mode = getEnforcementMode();
  if (mode === "off") return;

  const plan = await getAccountPlan(accountId);

  // Owner plan: always exempt.
  if (isUnlimited(plan)) return;

  const limits = getPlanLimits(plan);
  const creditLimit = limits.monthly_credits;

  // Ilimitado plan: soft-only (never hard block per spec §2).
  const isIlimitado = plan === "ilimitado";

  const used = await monthlyCreditsUsed(accountId);

  if (used + creditCost > creditLimit) {
    if (mode === "hard" && !isIlimitado) {
      throw new QuotaExceededError(
        `créditos/mês (${metric})`,
        creditLimit === UNLIMITED ? Number.POSITIVE_INFINITY : creditLimit,
        Math.round(used),
      );
    }
    // soft mode or ilimitado: log but allow.
    console.warn(
      `[billing:soft] account=${accountId} plan=${plan} metric=${metric} used=${used.toFixed(1)} limit=${creditLimit} cost=${creditCost} — over limit (allowed in ${mode} mode)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Existing enforcement functions (unchanged; backward compat)
// ---------------------------------------------------------------------------

/** Sum of usage_log.qty for (account, metric) since `since`. 0 when no DB. */
export async function queryUsage(accountId: string, metric: string, since: Date): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ total: string | null }>(
    `SELECT COALESCE(sum(qty),0)::text AS total FROM usage_log
       WHERE account_id=$1 AND metric=$2 AND ts >= $3`,
    [accountId, metric, since],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Current indexed chunk count for an account (the storage "level", not the
 *  usage_log 'chunks' throughput meter which double-counts re-indexing). */
export async function countChunks(accountId: string): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM brain_chunks WHERE account_id=$1`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function countWorkspaces(accountId: string): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM account_workspaces WHERE account_id=$1`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function assertSearchWithinLimit(accountId: string): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const used = await queryUsage(accountId, "search", monthStartUTC());
  if (used >= limits.searchesPerMonth) {
    throw new QuotaExceededError("buscas/mês", limits.searchesPerMonth, used);
  }
}

export async function assertChunksWithinLimit(accountId: string, incoming: number): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const current = await countChunks(accountId);
  if (current + incoming > limits.maxChunks) {
    throw new QuotaExceededError("chunks indexados", limits.maxChunks, current);
  }
}

/** The account's chunk cap as a number (Infinity for owner/default/unlimited).
 *  Used by replaceDocumentChunks (the per-account indexing path) to enforce the
 *  cap inside its transaction with a single POST-DELETE count — accurate for
 *  re-indexing an existing document (never false-blocks a same-size replace). */
export async function chunkCapFor(accountId: string): Promise<number> {
  if (accountId === DEFAULT_ACCOUNT_ID) return Number.POSITIVE_INFINITY;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return Number.POSITIVE_INFINITY;
  return getPlanLimits(plan).maxChunks;
}

export async function assertOnDemandWithinLimit(accountId: string, pages: number): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  if (limits.onDemandPagesPerDay <= 0) {
    throw new QuotaExceededError("indexação on-demand (não incluída no plano)", 0, 0);
  }
  const used = await queryUsage(accountId, "index_pages", dayStartUTC());
  if (used + pages > limits.onDemandPagesPerDay) {
    throw new QuotaExceededError("páginas on-demand/dia", limits.onDemandPagesPerDay, used);
  }
}

/** Throws WorkspaceLimitError if the account is already at its plan's
 *  maxWorkspaces. Owner/default exempt. Call BEFORE associating a new workspace. */
export async function assertCanAddWorkspace(accountId: string): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const current = await countWorkspaces(accountId);
  if (current >= limits.maxWorkspaces) {
    throw new WorkspaceLimitError(limits.maxWorkspaces, current);
  }
}

/** True if the account's plan includes a feature. Owner/default has all. */
export async function accountHasFeature(accountId: string, feature: keyof PlanFeatures): Promise<boolean> {
  if (accountId === DEFAULT_ACCOUNT_ID) return true;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return true;
  return getPlanLimits(plan).features[feature];
}

// ---------------------------------------------------------------------------
// F7 — Cost alert guard-rail
// ---------------------------------------------------------------------------

/**
 * Check if an account's estimated LLM cost this month exceeds COST_ALERT_USD
 * (default $2). If so, log a warning and — when NTFY_URL is set — fire a
 * best-effort notify. Never throws, never blocks.
 *
 * @param accountId  Account to check.
 * @param llmCostUsd Estimated LLM cost for the account this month (USD).
 */
export async function checkCostAlert(accountId: string, llmCostUsd: number): Promise<void> {
  const threshold = parseFloat(process.env.COST_ALERT_USD ?? "2");
  if (!Number.isFinite(threshold) || llmCostUsd < threshold) return;

  const msg = `[billing:cost-alert] account=${accountId} llm_cost_usd=${llmCostUsd.toFixed(4)} threshold=${threshold}`;
  console.warn(msg);

  const ntfyUrl = process.env.NTFY_URL;
  if (ntfyUrl) {
    try {
      await fetch(ntfyUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: `Zinom cost alert: ${accountId} spent $${llmCostUsd.toFixed(2)} this month (threshold $${threshold})`,
      });
    } catch (err: any) {
      console.warn(`[billing:cost-alert] ntfy failed: ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Usage snapshot (extended with credits in F7)
// ---------------------------------------------------------------------------

export interface UsageSnapshot {
  plan: string;
  chunks: { used: number; limit: number };
  searches: { used: number; limit: number };
  onDemand: { used: number; limit: number };
  // F7: unified credit meter
  credits: { used: number; limit: number };
}

export async function getUsageSnapshot(accountId: string): Promise<UsageSnapshot> {
  const plan = await getAccountPlan(accountId);
  const limits = getPlanLimits(plan);
  const [chunks, searches, onDemand, creditsUsed] = await Promise.all([
    countChunks(accountId),
    queryUsage(accountId, "search", monthStartUTC()),
    queryUsage(accountId, "index_pages", dayStartUTC()),
    monthlyCreditsUsed(accountId),
  ]);
  return {
    plan,
    chunks: { used: chunks, limit: limits.maxChunks },
    searches: { used: searches, limit: limits.searchesPerMonth },
    onDemand: { used: onDemand, limit: limits.onDemandPagesPerDay },
    credits: { used: Math.round(creditsUsed), limit: limits.monthly_credits },
  };
}
