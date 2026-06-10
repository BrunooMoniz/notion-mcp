// src/rag/brain-feedback-tool.ts
// Spec 004 §4 — MCP tool `brain_feedback`.
// Instructs the assistant to report which chunks it actually used.
// Scope: per-account (cross-account chunk → silently ignored / 404).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId } from "../context.js";
import { applyFeedback } from "./feedback.js";
import { UTILITY_WEIGHTS } from "./utility.js";
import { getPool } from "./storage.js";

/** Injected pool for tests (avoids DB in unit tests). */
type PoolLike = Parameters<typeof applyFeedback>[1];
let injectedPool: PoolLike | undefined;

/** Test-only seam. */
export function __setFeedbackPoolForTest(p: PoolLike | null): void {
  injectedPool = p ?? undefined;
}

export function registerBrainFeedbackTool(server: McpServer): void {
  server.tool(
    "brain_feedback",
    `Report which brain_search chunks were actually useful for your final answer.

Call this tool AFTER brain_search, once you know which retrieved chunks you cited or relied on.
This signal improves future retrieval: useful chunks rise in ranking; useless ones fade.

- useful_chunk_ids: chunk IDs from brain_search results that you used in your answer.
- useless_chunk_ids: chunk IDs that you retrieved but were irrelevant or wrong.
- note: optional free-text context (e.g. "answered the user's question about X").

Scope: feedback only applies to chunks belonging to the current account.
Cross-account chunk IDs are silently ignored (no error).`,
    {
      useful_chunk_ids: z.array(z.string()).optional().default([]),
      useless_chunk_ids: z.array(z.string()).optional().default([]),
      note: z.string().optional(),
    },
    async (args) => {
      const accountId = getAccountId();
      const pool = injectedPool ?? getPool();

      const results: { chunk_id: string; status: string }[] = [];

      // Apply positive delta for useful chunks.
      for (const chunkId of args.useful_chunk_ids ?? []) {
        const r = await applyFeedback(
          {
            accountId,
            chunkId,
            source: "assistant",
            delta: UTILITY_WEIGHTS.assistant_useful,
            query: args.note,
          },
          pool,
        );
        results.push({ chunk_id: chunkId, status: r.status });
      }

      // Apply negative delta for useless chunks.
      for (const chunkId of args.useless_chunk_ids ?? []) {
        const r = await applyFeedback(
          {
            accountId,
            chunkId,
            source: "assistant",
            delta: UTILITY_WEIGHTS.assistant_useless,
            query: args.note,
          },
          pool,
        );
        results.push({ chunk_id: chunkId, status: r.status });
      }

      const updated = results.filter((r) => r.status === "updated").length;
      const notFound = results.filter((r) => r.status === "not_found").length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                updated,
                not_found: notFound,
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
