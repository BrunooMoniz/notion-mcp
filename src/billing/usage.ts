// src/billing/usage.ts
// Usage queries + quota enforcement on top of the existing passive metering
// (usage_log). The owner/default account is always exempt (fast path, no DB):
// DEFAULT_ACCOUNT_ID is Bruno, and every cron/eval/test context resolves to it,
// so existing behavior and tests are unchanged. Quota breaches THROW a typed
// error (never swallowed) — the caller surfaces a clear PT-BR message.
import { getPool, hasInjectedPool } from "../rag/storage.js";
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { getAccountPlan } from "./account-plan.js";
import { getPlanLimits, isUnlimited, type PlanFeatures } from "./plans.js";

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

export interface UsageSnapshot {
  plan: string;
  chunks: { used: number; limit: number };
  searches: { used: number; limit: number };
  onDemand: { used: number; limit: number };
}

export async function getUsageSnapshot(accountId: string): Promise<UsageSnapshot> {
  const plan = await getAccountPlan(accountId);
  const limits = getPlanLimits(plan);
  const [chunks, searches, onDemand] = await Promise.all([
    countChunks(accountId),
    queryUsage(accountId, "search", monthStartUTC()),
    queryUsage(accountId, "index_pages", dayStartUTC()),
  ]);
  return {
    plan,
    chunks: { used: chunks, limit: limits.maxChunks },
    searches: { used: searches, limit: limits.searchesPerMonth },
    onDemand: { used: onDemand, limit: limits.onDemandPagesPerDay },
  };
}
