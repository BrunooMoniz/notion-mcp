// src/rag/brain-index-web-tool.ts
// F2.2: MCP tool — index an arbitrary web page/article by URL into the brain RAG
// on demand. Fetches the URL, extracts readable text, chunks+embeds, and upserts
// under source_type "web" (replace-on-write, so re-indexing a URL refreshes it).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Workspace } from "../clients.js";
import { assertWorkspaceScope, getAccountId } from "../context.js";
import { getAllowedWorkspaces } from "../getAllowedWorkspaces.js";
import { indexDocument } from "./index-document.js";
import { deleteBySource, upsertChunks } from "./storage.js";
import { fetchWebDocument } from "./sources/web-source.js";
import { recordUsage } from "./usage.js";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../billing/usage.js";

export interface IndexWebOutcome {
  source_id: string;
  title: string | null;
  chunks: number;
  text_chars: number;
}

/**
 * Core index-a-web-page path, shared by the MCP tool below and the portal's
 * POST /portal/index-web (002-app-v2). `accountId` is EXPLICIT (the portal
 * passes the session account; the tool passes getAccountId()). Enforces the
 * index_pages quota, fetches+chunks+embeds, replace-on-write, and meters usage.
 * Throws QuotaExceededError / fetch errors — callers map them to their surface.
 */
export async function indexWebForAccount(
  accountId: string,
  url: string,
  workspace: Workspace | null,
): Promise<IndexWebOutcome> {
  // Fase 3 billing — on-demand indexing gated by plan (Free = off) + daily cap.
  await assertOnDemandWithinLimit(accountId, 1);
  const doc = await fetchWebDocument(url, { workspace });
  doc.account_id = accountId; // F3.0: attribute to the caller's tenant
  const chunks = await indexDocument(doc);
  await deleteBySource("web", doc.source_id, accountId);
  await upsertChunks(chunks);
  await recordUsage(accountId, "index_pages", 1);
  return {
    source_id: doc.source_id,
    title: (doc.metadata.title as string | undefined) ?? null,
    chunks: chunks.length,
    text_chars: doc.text.length,
  };
}

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
        .string()
        .optional()
        .describe("Which workspace to tag this web document with. Optional — defaults to your primary workspace."),
      url: z
        .string()
        .url()
        .describe("Full http(s) URL of the page/article to index"),
    },
    async ({ workspace, url }) => {
      // Resolve the workspace: a friend's workspaces have arbitrary names/ids and
      // they won't know them, so default to their first allowed workspace (the
      // brain-read scope). Owner ("all") keeps the explicit value or "personal".
      const allowed = getAllowedWorkspaces();
      const resolvedWs = (workspace ?? allowed?.[0] ?? "personal") as Workspace;
      // Security gate: enforce token workspace scope on the resolved value.
      // No-op for bearer ("all") and for non-HTTP contexts (startup/cron/tests).
      assertWorkspaceScope(resolvedWs);
      const workspaceTag = resolvedWs;

      try {
        const accountId = getAccountId();
        const out = await indexWebForAccount(accountId, url, workspaceTag);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                source_type: "web",
                workspace: workspaceTag,
                url,
                source_id: out.source_id,
                title: out.title,
                chunks: out.chunks,
                text_chars: out.text_chars,
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
