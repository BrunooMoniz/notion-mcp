// src/rag/brain-reindex-tool.ts
// brain_reindex MCP tool — triggers an async re-index of the caller's brain.
// Uses the same in-flight guard as the portal /portal/reindex route so concurrent
// triggers (from the MCP and from the portal UI simultaneously) are deduplicated.
// Deps are injected for unit testability; the real deps use indexAccount().

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";

// ---------- dep-injection seam -----------------------------------------------

export interface BrainReindexDeps {
  isRunning(accountId: string): boolean;
  markRunning(accountId: string): void;
  unmarkRunning(accountId: string): void;
  indexAccount(accountId: string): Promise<{ documents: number; chunks: number }>;
}

export async function handleBrainReindex(
  accountId: string,
  deps: BrainReindexDeps,
): Promise<{ started: boolean; already_running: boolean }> {
  if (deps.isRunning(accountId)) {
    return { started: true, already_running: true };
  }

  deps.markRunning(accountId);
  // Fire-and-forget — mirrors the pattern in /portal/reindex.
  void deps
    .indexAccount(accountId)
    .catch((e: unknown) =>
      console.error(
        `[brain_reindex] ${accountId} failed: ${(e as Error)?.message ?? e}`,
      ),
    )
    .finally(() => deps.unmarkRunning(accountId));

  return { started: true, already_running: false };
}

// ---------- shared in-flight set (shared with brain_status) -------------------

/** The in-flight Set is owned by index.ts and injected here via setReindexSet. */
let _reindexInFlight: Set<string> | null = null;

export function setReindexSet(s: Set<string>): void {
  _reindexInFlight = s;
}

function getSet(): Set<string> {
  if (!_reindexInFlight) {
    // Fallback: create a local set (never happens in prod where index.ts calls setReindexSet).
    _reindexInFlight = new Set();
  }
  return _reindexInFlight;
}

const DESCRIPTION = `Dispara a reindexação do seu Zinom (segundo cérebro) de forma assíncrona.

Relê todas as fontes conectadas (Notion, Granola, Calendário) e atualiza os índices. Idêntico ao botão "Indexar agora" do portal.

Use quando:
- brain_status reportar fontes desatualizadas (stale) ou com erro;
- brain_search não encontrar algo recentemente adicionado/editado;
- o usuário pedir explicitamente para reindexar, atualizar ou "indexar agora".

Retorna {started, already_running}. A indexação roda em segundo plano — não espere por ela na mesma conversa; oriente o usuário a aguardar alguns minutos e tentar novamente.`;

export function registerBrainReindexTool(server: McpServer): void {
  server.tool(
    "brain_reindex",
    DESCRIPTION,
    {},
    async () => {
      const accountId = getAccountId() ?? DEFAULT_ACCOUNT_ID;

      const realDeps: BrainReindexDeps = {
        isRunning: (id) => getSet().has(id),
        markRunning: (id) => getSet().add(id),
        unmarkRunning: (id) => getSet().delete(id),
        indexAccount: async (id) => {
          const { indexAccount } = await import("./index-account.js");
          return indexAccount(id);
        },
      };

      const payload = await handleBrainReindex(accountId, realDeps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
