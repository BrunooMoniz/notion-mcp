// src/rag/brain-list-documents-tool.ts
// brain_list_documents MCP tool — browse the account's indexed documents
// (one row per source_id). Pure SQL, no Voyage, no search quota usage.
// Reuses listBrainDocuments from storage.ts (same query as portal /brain/documents).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainDocument } from "./storage.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";

// ---------- dep-injection seam -----------------------------------------------

export interface BrainListDocumentsDeps {
  listBrainDocuments(
    accountId: string,
    opts: { sourceType?: string; q?: string; limit?: number; offset?: number },
  ): Promise<BrainDocument[]>;
}

export interface BrainListDocumentsArgs {
  source_type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export async function handleBrainListDocuments(
  accountId: string,
  args: BrainListDocumentsArgs,
  deps: BrainListDocumentsDeps,
): Promise<{ documents: BrainDocument[] }> {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const documents = await deps.listBrainDocuments(accountId, {
    sourceType: args.source_type,
    q: args.q,
    limit,
    offset: args.offset,
  });
  return { documents };
}

// ---------- MCP registration --------------------------------------------------

const DESCRIPTION = `Lista os documentos indexados no Zinom (segundo cérebro) desta conta.

Retorna uma linha por documento (source_id distinto): título, fonte (notion/granola/calendar/web/conversation), workspace, url, data.

Use para:
- navegar o que está no cérebro sem fazer uma busca semântica;
- verificar se um documento específico foi indexado;
- listar todos os documentos de uma fonte (ex.: source_type="granola").

Parâmetros:
- source_type (opcional): filtra por fonte (notion/granola/calendar/web/conversation).
- q (opcional): substring ILIKE no texto — barato, sem quota.
- limit (padrão 20, máx 50): quantos documentos retornar.
- offset (padrão 0): paginação.

Não usa quota de busca.`;

export function registerBrainListDocumentsTool(server: McpServer): void {
  server.tool(
    "brain_list_documents",
    DESCRIPTION,
    {
      source_type: z
        .enum(["notion", "granola", "calendar", "web", "conversation"])
        .optional()
        .describe("Filtrar por tipo de fonte"),
      q: z.string().optional().describe("Substring de texto para filtro rápido (sem quota)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`Número de documentos (padrão ${DEFAULT_LIMIT}, máx ${MAX_LIMIT})`),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset para paginação"),
    },
    async ({ source_type, q, limit, offset }) => {
      const accountId = getAccountId() ?? DEFAULT_ACCOUNT_ID;
      const { listBrainDocuments } = await import("./storage.js");

      const deps: BrainListDocumentsDeps = { listBrainDocuments };
      const payload = await handleBrainListDocuments(
        accountId,
        { source_type, q, limit, offset },
        deps,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
