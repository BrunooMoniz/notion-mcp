// src/health/budgets.ts
// Painel de saúde: módulo de créditos/orçamento de IA.
// Três checks: budget:anthropic, budget:voyage, tokens:llm.
// Spec: docs/superpowers/specs/2026-06-11-admin-health-dashboard-design.md (TC)

import type { CheckResult, HealthStatus } from "./types.js";
import { getOrgCostReport } from "../admin/anthropic-cost.js";
import { summariseCostReport, type CostReportResponse } from "../admin/business.js";
import { monthStartUTC } from "../billing/usage.js";
import { getPool } from "../rag/storage.js";

// ---------------------------------------------------------------------------
// evalBudget — lógica de limiar pura (testável sem I/O)
// ---------------------------------------------------------------------------

/**
 * Avalia o status de orçamento dado o gasto atual e o limite configurado.
 *
 * - budgetUsd undefined → ok (informacional, sem alerta)
 * - pct >= 100 → fail
 * - pct >= 80  → warn
 * - caso contrário → ok
 *
 * Nota: se budgetUsd = 0 e spentUsd = 0, pct = NaN → tratado como Infinity → fail.
 */
export function evalBudget(spentUsd: number, budgetUsd: number | undefined): HealthStatus {
  if (budgetUsd === undefined) return "ok";
  const pct = (spentUsd / budgetUsd) * 100;
  if (!Number.isFinite(pct) || pct >= 100) return "fail";
  if (pct >= 80) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// voyageSpentUsd — aritmética pura (testável sem DB)
// ---------------------------------------------------------------------------

/**
 * Converte tokens embed em custo USD.
 * @param embedTokens  Total de tokens embed (SUM qty de usage_log).
 * @param costPerMtok  Custo por milhão de tokens (USD).
 */
export function voyageSpentUsd(embedTokens: number, costPerMtok: number): number {
  return (embedTokens / 1_000_000) * costPerMtok;
}

// ---------------------------------------------------------------------------
// anthropicBudgetCheck
// ---------------------------------------------------------------------------

type GetReportFn = () => Promise<CostReportResponse | null>;

/**
 * Check "budget:anthropic": gasto MTD real via Admin API vs HEALTH_BUDGET_ANTHROPIC_USD.
 *
 * - getReport null (ANTHROPIC_ADMIN_KEY ausente) → skip
 * - getReport lança erro → fail com mensagem truncada em 200 chars
 * - sem HEALTH_BUDGET_ANTHROPIC_USD → ok informacional (budgetUsd e pct nulos no detail)
 */
export async function anthropicBudgetCheck(
  getReport: GetReportFn = getOrgCostReport,
): Promise<CheckResult[]> {
  let report: CostReportResponse | null;

  try {
    report = await getReport();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        checkId: "budget:anthropic",
        label: "Crédito Anthropic (mês)",
        group: "creditos",
        status: "fail",
        error: msg.slice(0, 200),
      },
    ];
  }

  if (report === null) {
    return [
      {
        checkId: "budget:anthropic",
        label: "Crédito Anthropic (mês)",
        group: "creditos",
        status: "skip",
        error: "ANTHROPIC_ADMIN_KEY não configurada",
      },
    ];
  }

  const { totalUsdCents } = summariseCostReport(report);
  const spentUsd = totalUsdCents / 100;

  const budgetRaw = process.env.HEALTH_BUDGET_ANTHROPIC_USD;
  const budgetUsd = budgetRaw !== undefined ? parseFloat(budgetRaw) : undefined;

  const pct =
    budgetUsd !== undefined
      ? Math.round(((spentUsd / budgetUsd) * 100) * 10) / 10
      : null;

  const status = evalBudget(spentUsd, budgetUsd);

  return [
    {
      checkId: "budget:anthropic",
      label: "Crédito Anthropic (mês)",
      group: "creditos",
      status,
      detail: {
        spentUsd,
        budgetUsd: budgetUsd ?? null,
        pct,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// voyageBudgetCheck
// ---------------------------------------------------------------------------

/**
 * Check "budget:voyage": estima custo Voyage AI com tokens embed do mês.
 *
 * Fonte: SUM(qty) de usage_log WHERE metric='embed_tokens' desde monthStartUTC().
 * Custo = tokens × COST_EMBED_PER_MTOK / 1e6.
 *
 * - sem COST_EMBED_PER_MTOK → skip
 */
export async function voyageBudgetCheck(): Promise<CheckResult[]> {
  const costRaw = process.env.COST_EMBED_PER_MTOK;
  if (costRaw === undefined) {
    return [
      {
        checkId: "budget:voyage",
        label: "Crédito Voyage (mês, estimado)",
        group: "creditos",
        status: "skip",
        error: "COST_EMBED_PER_MTOK não configurada",
      },
    ];
  }

  const costPerMtok = parseFloat(costRaw);

  let embedTokens = 0;
  try {
    const pool = getPool();
    const since = monthStartUTC();
    const { rows } = await pool.query<{ total: string | null }>(
      `SELECT COALESCE(sum(qty), 0)::text AS total FROM usage_log
         WHERE metric = 'embed_tokens' AND ts >= $1`,
      [since],
    );
    embedTokens = Number(rows[0]?.total ?? 0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        checkId: "budget:voyage",
        label: "Crédito Voyage (mês, estimado)",
        group: "creditos",
        status: "fail",
        error: msg.slice(0, 200),
      },
    ];
  }

  const spentUsd = voyageSpentUsd(embedTokens, costPerMtok);

  const budgetRaw = process.env.HEALTH_BUDGET_VOYAGE_USD;
  const budgetUsd = budgetRaw !== undefined ? parseFloat(budgetRaw) : undefined;

  const pct =
    budgetUsd !== undefined
      ? Math.round(((spentUsd / budgetUsd) * 100) * 10) / 10
      : null;

  const status = evalBudget(spentUsd, budgetUsd);

  return [
    {
      checkId: "budget:voyage",
      label: "Crédito Voyage (mês, estimado)",
      group: "creditos",
      status,
      detail: {
        spentUsd,
        budgetUsd: budgetUsd ?? null,
        pct,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// llmTokensCheck
// ---------------------------------------------------------------------------

/**
 * Check "tokens:llm": totaliza tokens LLM do mês (input + output).
 * Sempre retorna status "ok" (informacional).
 */
export async function llmTokensCheck(): Promise<CheckResult[]> {
  let inTokens = 0;
  let outTokens = 0;

  try {
    const pool = getPool();
    const since = monthStartUTC();
    const { rows } = await pool.query<{ metric: string; total: string | null }>(
      `SELECT metric, COALESCE(sum(qty), 0)::text AS total FROM usage_log
         WHERE metric IN ('llm_input_tokens', 'llm_output_tokens') AND ts >= $1
         GROUP BY metric`,
      [since],
    );
    for (const row of rows) {
      if (row.metric === "llm_input_tokens") inTokens = Number(row.total ?? 0);
      if (row.metric === "llm_output_tokens") outTokens = Number(row.total ?? 0);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        checkId: "tokens:llm",
        label: "Tokens LLM (mês)",
        group: "creditos",
        status: "fail",
        error: msg.slice(0, 200),
      },
    ];
  }

  return [
    {
      checkId: "tokens:llm",
      label: "Tokens LLM (mês)",
      group: "creditos",
      status: "ok",
      detail: {
        inTokens,
        outTokens,
      },
    },
  ];
}
