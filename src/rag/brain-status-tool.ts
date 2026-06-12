// src/rag/brain-status-tool.ts
// brain_status MCP tool — returns brain health and chunk counts for an account.
// Pure compute (buildBrainStatus) decoupled from I/O via injected deps so it is
// unit-testable without a DB connection. Registration (registerBrainStatusTool)
// wires real deps and handles the MCP plumbing.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StatusSource } from "./status.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";

// ---------- dep-injection seam (test-friendly) --------------------------------

export interface BrainStatusDeps {
  getStatus(accountId: string): Promise<StatusSource[]>;
  getBrainCounts(accountId: string): Promise<{
    bySource: { source_type: string; documents: number; chunks: number; last_indexed_at: Date | null }[];
    totals: { documents: number; chunks: number };
  }>;
  /** Synchronous check — whether a reindex is currently in flight for accountId. */
  isRunning(accountId: string): boolean;
  /** Identity of the account this MCP session serves (Frente B #97) — shows the
   *  user WHICH account answered when they have more than one. */
  getAccount(accountId: string): Promise<AccountIdentity>;
}

export interface AccountIdentity {
  email: string | null;
  plan: string;
}

export interface AccountIdentityReaders {
  email(accountId: string): Promise<string | null>;
  plan(accountId: string): Promise<string>;
}

/** Identity block for the brain_status payload. The OPERATOR short-circuits to
 *  { email: null, plan: "owner" } without touching the DB; a friend account
 *  reads email/plan from the account table via the injected readers. */
export async function getAccountIdentity(
  accountId: string,
  readers: AccountIdentityReaders,
): Promise<AccountIdentity> {
  if (accountId === DEFAULT_ACCOUNT_ID) return { email: null, plan: "owner" };
  const [email, plan] = await Promise.all([
    readers.email(accountId),
    readers.plan(accountId),
  ]);
  return { email, plan };
}

/** Build the brain status payload. Pure computation over injected I/O results. */
export async function buildBrainStatus(
  accountId: string,
  deps: BrainStatusDeps,
): Promise<{
  running: boolean;
  account: AccountIdentity;
  sources: StatusSource[];
  counts: {
    bySource: { source_type: string; documents: number; chunks: number; last_indexed_at: Date | null }[];
    totals: { documents: number; chunks: number };
  };
}> {
  const [rawSources, counts, account] = await Promise.all([
    deps.getStatus(accountId),
    deps.getBrainCounts(accountId),
    deps.getAccount(accountId),
  ]);
  return {
    running: deps.isRunning(accountId),
    account,
    sources: rawSources,
    counts,
  };
}

// ---------- MCP registration --------------------------------------------------

/** Shared in-flight set so brain_reindex and brain_status both see the same guard. */
let _reindexInFlight: Set<string> | null = null;

export function setReindexInFlightSet(s: Set<string>): void {
  _reindexInFlight = s;
}

function isRunning(accountId: string): boolean {
  return _reindexInFlight?.has(accountId) ?? false;
}

const DESCRIPTION = `Retorna a saúde e contadores do seu Zinom (segundo cérebro).

Mostra: se uma reindexação está em curso, quais fontes (Notion, Granola, Calendar) foram indexadas com sucesso ou estão com problema, quando foi o último run, se está desatualizado (stale > 3h sem run), e totais de documentos e chunks por fonte. Inclui também a identidade da conta atendida (account.email, account.plan) — útil quando a pessoa tem mais de uma conta e quer saber qual delas este MCP está atendendo.

Use quando perguntarem "por que não encontrou X?", "está atualizado?", "minhas fontes estão funcionando?", ou quando um brain_search voltar vazio inesperadamente.

Não usa quota de busca — leitura pura do banco de status.`;

export function registerBrainStatusTool(server: McpServer): void {
  server.tool(
    "brain_status",
    DESCRIPTION,
    {},
    async () => {
      const accountId = getAccountId() ?? DEFAULT_ACCOUNT_ID;
      const { getStatus, getBrainCounts } = await import("./storage.js");
      const { summarizeStatus } = await import("./status.js");

      const deps: BrainStatusDeps = {
        getStatus: (id) => getStatus(id).then(summarizeStatus),
        getBrainCounts,
        isRunning,
        getAccount: async (id) => {
          const [{ getAccountEmail }, { getAccountPlan }] = await Promise.all([
            import("../portal/accounts.js"),
            import("../billing/account-plan.js"),
          ]);
          return getAccountIdentity(id, { email: getAccountEmail, plan: getAccountPlan });
        },
      };

      const payload = await buildBrainStatus(accountId, deps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
