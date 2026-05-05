// src/rag/brain-tool.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { brainSearch } from "./search.js";
import type { SearchFilters } from "./types.js";

const filtersSchema = z
  .object({
    workspace: z.enum(["personal", "globalcripto", "nora"]).optional(),
    db: z.string().optional(),
    frente: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    pessoa: z.string().optional(),
  })
  .optional();

export function registerBrainSearchTool(server: McpServer): void {
  server.tool(
    "brain_search",
    `Search Bruno's second brain (Notion personal workspace in Fase 1; Granola, Calendar, and other workspaces in Fase 2).
Hybrid retrieval combines semantic vector search with PT-BR full-text. Returns chunks with metadata, scores, and source URLs.

Use cases:
- Lookup pontual: pass a specific question, get matching chunks.
- Sintese: pass a topic, retrieve enough chunks to summarize across.
- Conexao: pass an entity name and date range, find related items.`,
    {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(50).default(12),
      mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
      include_neighbors: z.boolean().default(false),
      filters: filtersSchema,
    },
    async (args) => {
      const filters = args.filters as SearchFilters | undefined;
      const hits = await brainSearch(args.query, {
        topK: args.top_k,
        mode: args.mode,
        filters,
        includeNeighbors: args.include_neighbors,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: args.query,
                mode: args.mode,
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
