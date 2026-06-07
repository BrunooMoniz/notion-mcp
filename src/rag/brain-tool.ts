// src/rag/brain-tool.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { brainSearch } from "./search.js";
import type { SearchFilters } from "./types.js";
import { QuotaExceededError } from "../billing/usage.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";
import { toBrainResult } from "./brain-format.js";

/**
 * The real source_type values a chunk can have — the single source of truth for
 * the brain_search source_type / exclude_source_type filter enums. Includes
 * "conversation" (objective #4 conversation memory) and "web" (a real source_type
 * that the filter previously omitted). Exported so a unit test can assert no valid
 * source is silently dropped from the filter again.
 */
export const SOURCE_TYPE_FILTER_VALUES = [
  "notion",
  "granola",
  "calendar",
  "web",
  "conversation",
] as const;

const filtersSchema = z
  .object({
    // Free-form string, not a fixed enum: a friend's workspaces have arbitrary
    // names/ids. Security does NOT depend on this value — brainSearch always
    // scopes results to the caller's account_id + allowed workspaces, so an
    // unknown/foreign workspace simply yields zero rows.
    workspace: z.string().optional(),
    db: z.string().optional(),
    frente: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    pessoa: z.string().optional(),
    source_type: z.enum(SOURCE_TYPE_FILTER_VALUES).optional(),
    exclude_source_type: z.enum(SOURCE_TYPE_FILTER_VALUES).optional(),
  })
  .optional();

export function registerBrainSearchTool(server: McpServer): void {
  server.tool(
    "brain_search",
    `Search your Zinom (second brain) — indexed Notion pages, Granola meeting notes, and Calendar events across your connected sources.
Hybrid retrieval combines semantic vector search with PT-BR full-text, then a cross-encoder reranker (Voyage rerank) reorders the candidate pool by relevance. Scores are real relevance scores (reranker relevance_score, or normalized hybrid fusion when rerank is off/unavailable). Results are scoped to the caller's allowed workspaces.

Each result has: title, text, score, source_type ("notion" | "granola" | "calendar" | "web" | "conversation"), source_url, workspace, db, metadata. CITE YOUR SOURCES: when you answer from these results, list the sources that contributed as markdown links — [title](source_url) — labeled by source_type (página do Notion / reunião do Granola / evento do Calendar / página da web / conversa). When source_url is null (some calendar events have no per-event link, and conversation memories never do), cite by title + date (metadata.data) instead. "conversation" results are notes the user saved via the remember tool — recall them on their own with source_type:"conversation". notion_url is a deprecated alias of source_url.

Use cases:
- Lookup pontual: pass a specific question, get matching chunks.
- Sintese: pass a topic, retrieve enough chunks to summarize across.
- Conexao: pass an entity name and date range, find related items.

Options:
- mode: "hybrid" (default, semantic + keyword fused) | "semantic" | "keyword".
- rerank: true (default) to apply the cross-encoder reranker; false to skip it (faster, ranks by normalized hybrid score).
- filters: scope by workspace, db, frente, date range, pessoa, or source_type / exclude_source_type (one of notion/granola/calendar/web/conversation — e.g. source_type: "conversation" to recall only saved conversation memories, or exclude_source_type: "calendar" to drop event noise). Date filters match metadata.data (falling back to last-updated); chunks with no date are included unless bounded out. pessoa matches Notion people + Granola attendees, accent- and case-insensitive.`,
    {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(50).default(12),
      mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
      rerank: z.boolean().default(true),
      include_neighbors: z.boolean().default(false),
      filters: filtersSchema,
    },
    async (args) => {
      const filters = args.filters as SearchFilters | undefined;
      let hits;
      try {
        hits = await brainSearch(args.query, {
          topK: args.top_k,
          mode: args.mode,
          rerank: args.rerank,
          filters,
          includeNeighbors: args.include_neighbors,
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "quota_exceeded", message: e.message }, null, 2) },
            ],
          };
        }
        throw e;
      }
      // Empty-state orientation for friend accounts: a silent [] reads as
      // "broken". Tell them the likely next action (index their sources) instead.
      const isFriend = getAccountId() !== DEFAULT_ACCOUNT_ID;
      const hint =
        hits.length === 0 && isFriend
          ? "Nenhum resultado no seu Zinom para essa busca. Se você conectou ou editou suas fontes agora há pouco, abra o portal (zinom.ai), clique em 'Indexar agora' e tente de novo."
          : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: args.query,
                mode: args.mode,
                ...(hint ? { hint } : {}),
                results: hits.map(toBrainResult),
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
