// src/rag/brain-tool.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { brainSearch } from "./search.js";
import type { SearchFilters } from "./types.js";
import { QuotaExceededError } from "../billing/usage.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";

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
    source_type: z.enum(["notion", "granola", "calendar"]).optional(),
    exclude_source_type: z.enum(["notion", "granola", "calendar"]).optional(),
  })
  .optional();

export function registerBrainSearchTool(server: McpServer): void {
  server.tool(
    "brain_search",
    `Search your Zinom (second brain) — indexed Notion pages, Granola meeting notes, and Calendar events across your connected sources.
Hybrid retrieval combines semantic vector search with PT-BR full-text, then a cross-encoder reranker (Voyage rerank) reorders the candidate pool by relevance. Scores are real relevance scores (reranker relevance_score, or normalized hybrid fusion when rerank is off/unavailable). Results are scoped to the caller's allowed workspaces. Returns chunks with metadata, scores, and source URLs.

Use cases:
- Lookup pontual: pass a specific question, get matching chunks.
- Sintese: pass a topic, retrieve enough chunks to summarize across.
- Conexao: pass an entity name and date range, find related items.

Options:
- mode: "hybrid" (default, semantic + keyword fused) | "semantic" | "keyword".
- rerank: true (default) to apply the cross-encoder reranker; false to skip it (faster, ranks by normalized hybrid score).
- filters: scope by workspace, db, frente, date range, pessoa, or source_type / exclude_source_type (e.g. exclude_source_type: "calendar" to drop event noise). Date filters match metadata.data (falling back to last-updated); chunks with no date are included unless bounded out. pessoa matches Notion people + Granola attendees, accent- and case-insensitive.`,
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
                results: hits.map((h) => ({
                  text: h.chunk.text,
                  score: h.score,
                  notion_url: h.chunk.parent_url,
                  source_type: h.chunk.source_type,
                  workspace: h.chunk.workspace,
                  db: h.chunk.db_name,
                  metadata: h.chunk.metadata,
                  neighbors: h.neighbors?.map((n) => n.text) ?? [],
                })),
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
