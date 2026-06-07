// src/rag/remember-tool.ts
// Objective #4 — conversation memory. The `remember` MCP tool lets the assistant
// persist a note/summary from the live chat as a FIFTH source_type
// ("conversation") in the SAME brain_chunks store as every other source. It reuses
// the ingest pipeline verbatim (buildConversationDocument -> indexDocument ->
// upsertChunks), so the note becomes searchable + citable via brain_search with
// the SAME account isolation as any other chunk. There is NO parallel storage path.
//
// Security: account_id ALWAYS comes from the trusted request context
// (getAccountId), NEVER from tool input. The pure builder takes the account via an
// explicit seam so the handler cannot accidentally trust input, and tests can
// assert the isolation reasoning without a DB.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Workspace } from "../clients.js";
import { auditWrite } from "../audit.js";
import { getAccountId } from "../context.js";
import { getAllowedWorkspaces } from "../getAllowedWorkspaces.js";
import { indexDocument } from "./index-document.js";
import { deleteBySource, upsertChunks } from "./storage.js";
import { recordUsage } from "./usage.js";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../billing/usage.js";
import { brainSearch } from "./search.js";
import { toBrainResult } from "./brain-format.js";
import { buildConversationDocument } from "./remember-doc.js";
import type { SearchFilters } from "./types.js";

// The PURE document builder + its types live in remember-doc.ts (importable in a
// credential-less unit test). Re-exported here so existing importers of
// remember-tool keep working.
export {
  buildConversationDocument,
  type RememberInput,
  type RememberSeam,
} from "./remember-doc.js";

export function registerRememberTool(server: McpServer): void {
  server.tool(
    "remember",
    `Salve uma nota/resumo desta conversa no Zinom (segundo cérebro) para lembrar depois.

A nota é indexada como uma fonte do tipo "conversation" no MESMO acervo das outras
fontes, então fica pesquisável e citável via brain_search imediatamente (use
source_type:"conversation", ou a ferramenta recall, para recuperar só memórias de
conversa). Use quando a pessoa pedir "lembra disso", "anota isso", "guarda essa
decisão", ou quando você quiser persistir um resumo/conclusão importante do diálogo.

A nota fica isolada na conta da pessoa (mesma isolação de qualquer outro chunk).
Passe um \`title\` curto e descritivo: é por ele que a memória será citada depois.`,
    {
      text: z.string().min(1).describe("O texto da nota/resumo a lembrar (obrigatório)."),
      title: z
        .string()
        .optional()
        .describe("Título curto e descritivo — é o rótulo pelo qual a memória será citada."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags opcionais para agrupar/filtrar a memória depois."),
    },
    async ({ text, title, tags }) => {
      // Account scope from the TRUSTED context, never from input.
      const accountId = getAccountId();
      // Default workspace = the caller's first allowed workspace (their brain-read
      // scope); owner ("all") has no restriction -> tag as "personal".
      const allowed = getAllowedWorkspaces();
      const workspace = (allowed?.[0] ?? "personal") as Workspace;

      try {
        // It is a write/index: gate it by plan exactly like the other index tools.
        await assertOnDemandWithinLimit(accountId, 1);

        const doc = buildConversationDocument({ text, title, tags }, { accountId, workspace });
        const chunks = await indexDocument(doc);
        // Replace-on-write semantics, consistent with the other on-demand tools.
        await deleteBySource("conversation", doc.source_id, accountId);
        await upsertChunks(chunks);
        await recordUsage(accountId, "index_pages", 1);

        // It is a write — audit it (fire-and-forget, never throws).
        auditWrite("remember", workspace, { source_id: doc.source_id }, {
          source_type: "conversation",
          chunks: chunks.length,
          tags: doc.metadata.tags,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                source_type: "conversation",
                source_id: doc.source_id,
                title: doc.metadata.title,
                tags: doc.metadata.tags,
                workspace,
                chunks: chunks.length,
              }),
            },
          ],
        };
      } catch (e: any) {
        if (e instanceof QuotaExceededError) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "quota_exceeded", message: e.message }) }] };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: e?.code ?? "remember_failed", message: e?.message ?? String(e) }),
            },
          ],
        };
      }
    },
  );
}

/**
 * `recall` — thin convenience over brain_search, hard-filtered to conversation
 * memory (the notes saved with `remember`). It adds NO new search logic: it calls
 * the SAME brainSearch with source_type:"conversation". Account + workspace scope
 * are enforced inside brainSearch from the trusted context, exactly like
 * brain_search. (Equivalent to calling brain_search with that filter directly.)
 */
export function registerRecallTool(server: McpServer): void {
  server.tool(
    "recall",
    `Recupere SÓ as memórias de conversa (notas salvas com a ferramenta remember).

É um atalho do brain_search filtrado por source_type:"conversation". Use quando a
pessoa perguntar "o que você anotou sobre...", "lembra o que decidimos...", ou
quando quiser revisitar resumos do diálogo. Para buscar em TODAS as fontes (Notion,
Granola, Calendar, web, conversa), use brain_search.

Cada resultado traz title + source_type:"conversation". CITE a memória pelo título.`,
    {
      query: z.string().min(1).describe("O que recuperar das suas memórias de conversa."),
      top_k: z.number().int().min(1).max(50).default(12),
    },
    async ({ query, top_k }) => {
      const filters: SearchFilters = { source_type: "conversation" };
      const hits = await brainSearch(query, { topK: top_k, filters });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query, source_type: "conversation", results: hits.map(toBrainResult) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
