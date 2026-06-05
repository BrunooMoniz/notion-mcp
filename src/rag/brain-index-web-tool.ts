// src/rag/brain-index-web-tool.ts
// F2.2: MCP tool — index an arbitrary web page/article by URL into the brain RAG
// on demand. Fetches the URL, extracts readable text, chunks+embeds, and upserts
// under source_type "web" (replace-on-write, so re-indexing a URL refreshes it).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Workspace } from "../clients.js";
import { assertWorkspaceScope } from "../context.js";
import { indexDocument } from "./index-document.js";
import { deleteBySource, upsertChunks } from "./storage.js";
import { fetchWebDocument } from "./sources/web-source.js";

export function registerBrainIndexWebTool(server: McpServer): void {
  server.tool(
    "brain_index_web",
    `Index an arbitrary web page or article by URL into Bruno's brain RAG on demand.

Fetches the URL, extracts the readable text (strips scripts/styles/markup), chunks
and embeds it, and stores it under source_type "web" so it is queryable in
brain_search immediately. Re-indexing the same URL replaces the prior copy.

Use when the user shares a web link/article and says "indexa isso", "coloca no
cérebro", or "quero buscar isso depois". For Notion URLs, use brain_index_url
instead.

Returns counts and the resolved title/source_id.`,
    {
      workspace: z
        .enum(["personal", "globalcripto", "nora"])
        .describe("Which workspace to tag this web document with"),
      url: z
        .string()
        .url()
        .describe("Full http(s) URL of the page/article to index"),
    },
    async ({ workspace, url }) => {
      // Security gate: enforce token workspace scope before any work.
      // No-op for bearer ("all") and for non-HTTP contexts (startup/cron/tests).
      assertWorkspaceScope(workspace as Workspace);

      try {
        const doc = await fetchWebDocument(url, { workspace: workspace as Workspace });
        const chunks = await indexDocument(doc);
        await deleteBySource("web", doc.source_id);
        await upsertChunks(chunks);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                source_type: "web",
                workspace,
                url,
                source_id: doc.source_id,
                title: doc.metadata.title ?? null,
                chunks: chunks.length,
                text_chars: doc.text.length,
              }),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: e?.code ?? "fetch_or_index_failed",
                message: e?.message ?? String(e),
              }),
            },
          ],
        };
      }
    },
  );
}
