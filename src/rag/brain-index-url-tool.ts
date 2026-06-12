// src/rag/brain-index-url-tool.ts
// MCP tool: index any Notion page/database/data_source by URL or ID,
// on demand, into the brain RAG. Uses PAT for reads (full user access).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, notionFetch, type Workspace } from "../clients.js";
import { assertWorkspaceScope, getAccountId, getContext } from "../context.js";
import { isOwnerContext } from "../mcp-account-config.js";
import { accountWorkspacesWithNames } from "../account-bearer.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { deleteBySource, upsertChunks } from "./storage.js";
import { chunkId, pageToText, extractMetadata } from "./notion-source.js";
import type { ChunkWithEmbedding } from "./types.js";
import { recordUsage } from "./usage.js";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../billing/usage.js";

function extractNotionId(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.split("?")[0].split("#")[0].replace(/\/+$/, "");
  // Common cases: last "/"-delimited segment, then last "-"-delimited chunk.
  const lastPath = s.split("/").pop() ?? "";
  const lastChunk = lastPath.split("-").pop() ?? lastPath;
  const tryNorm = (raw: string): string | null => {
    const hex = raw.toLowerCase().replace(/-/g, "");
    if (!/^[a-f0-9]{32}$/.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  return tryNorm(lastChunk) ?? tryNorm(lastPath) ?? tryNorm(s);
}

interface IndexResult {
  source_id: string;
  chunks: number;
  text_chars: number;
  db_name: string | null;
  parent_url: string;
}

async function indexSinglePage(
  workspace: Workspace,
  page: any,
  dbName: string | null,
): Promise<IndexResult> {
  const readClient = getClient(workspace);
  const text = await pageToText(readClient, page);
  const result: IndexResult = {
    source_id: page.id,
    chunks: 0,
    text_chars: text.length,
    db_name: dbName,
    parent_url:
      page.url ?? `https://www.notion.so/${(page.id as string).replace(/-/g, "")}`,
  };
  if (!text.trim()) return result;

  const texts = chunkText(text);
  if (texts.length === 0) return result;
  const accountId = getAccountId(); // F3.0: attribute to the caller's tenant
  const embeddings = await batchEmbed(texts);
  const chunks: ChunkWithEmbedding[] = texts.map((t, idx) => ({
    id: chunkId(page.id, idx),
    source_type: "notion",
    source_id: page.id,
    workspace,
    db_name: dbName,
    parent_url: result.parent_url,
    chunk_index: idx,
    text: t,
    embedding: embeddings[idx],
    metadata: extractMetadata(page),
    source_updated: new Date(page.last_edited_time),
    account_id: accountId,
  }));
  await deleteBySource("notion", page.id, accountId);
  await upsertChunks(chunks);
  result.chunks = chunks.length;
  return result;
}

async function indexDataSource(
  workspace: Workspace,
  dataSourceId: string,
  dataSourceName: string | null,
  maxPages: number,
): Promise<{ pages: IndexResult[]; truncated: boolean }> {
  const pages: IndexResult[] = [];
  let cursor: string | undefined = undefined;
  let truncated = false;
  outer: do {
    const body: Record<string, unknown> = {
      page_size: 50,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const resp = (await notionFetch(workspace, `/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body,
    })) as { results: any[]; next_cursor: string | null };
    for (const page of resp.results) {
      if (!page?.properties) continue;
      try {
        const result = await indexSinglePage(workspace, page, dataSourceName);
        pages.push(result);
        if (pages.length >= maxPages) {
          truncated = !!resp.next_cursor || pages.length < resp.results.length;
          break outer;
        }
      } catch (err: any) {
        console.warn(`[brain_index_url] page ${page.id} failed: ${err.message ?? err}`);
      }
    }
    cursor = resp.next_cursor ?? undefined;
  } while (cursor);
  return { pages, truncated };
}

// ---------- per-session workspace schema (Frente B #97, multi-tenant) ----------

/** One connected Notion workspace of an account (account_workspaces row). */
export interface AccountWorkspaceEntry {
  workspace: string;
  name: string | null;
}

/** Injectable registration deps. Ownership and the account come ONLY from the
 *  trusted request context (the per-session registration in index.ts runs
 *  inside the auth middleware's scope), never from tool input. */
export interface BrainIndexUrlRegistrationDeps {
  isOwner(): boolean;
  getAccountId(): string;
  listWorkspaces(accountId: string): Promise<AccountWorkspaceEntry[]>;
}

const defaultRegistrationDeps: BrainIndexUrlRegistrationDeps = {
  isOwner: () => isOwnerContext(getContext()),
  getAccountId,
  listWorkspaces: accountWorkspacesWithNames,
};

export const NO_NOTION_WORKSPACE_MESSAGE =
  "Esta conta não tem nenhum workspace Notion conectado — conecte um Notion no portal primeiro e tente de novo.";

/** The operator keeps the original fixed enum of his three workspaces. */
const OPERATOR_WORKSPACE_SCHEMA = z
  .enum(["personal", "globalcripto", "nora"])
  .describe("Which Notion workspace's PAT to use for the read");

export interface FriendWorkspaceParam {
  /** Session-scoped zod schema for the `workspace` argument. */
  schema: z.ZodTypeAny;
  /** False when the account has no Notion connected — the handler must answer
   *  a clear runtime error instead of indexing. */
  hasWorkspaces: boolean;
}

/** Build the `workspace` schema a FRIEND session sees: an enum with the
 *  account's OWN workspace ids (UUIDs) plus the display names in the
 *  description ("313d872b… = Global Cripto"). The operator's private workspace
 *  names never appear on a friend's tool surface. */
export function buildFriendWorkspaceParam(
  workspaces: AccountWorkspaceEntry[],
): FriendWorkspaceParam {
  if (workspaces.length === 0) {
    return {
      schema: z
        .string()
        .optional()
        .describe(
          "Nenhum workspace Notion conectado nesta conta — conecte um Notion no portal primeiro.",
        ),
      hasWorkspaces: false,
    };
  }
  const ids = workspaces.map((w) => w.workspace) as [string, ...string[]];
  const legend = workspaces
    .map((w) => (w.name ? `${w.workspace} = ${w.name}` : w.workspace))
    .join("; ");
  return {
    schema: z
      .enum(ids)
      .describe(`Workspace Notion desta conta a usar na leitura. Conectados: ${legend}`),
    hasWorkspaces: true,
  };
}

const OWNER_DESCRIPTION = `Index a Notion page, database, or data_source into Bruno's brain RAG on demand.

Accepts a full notion.so URL or a raw 32-hex ID. Tries page → data_source → database (which expands to its data_sources).

Use cases:
- User shares a Notion link and wants it queryable in brain_search immediately.
- Pulling content the indexer's discovery doesn't surface (PAT can read anything the user has access to, but /v1/search returns 0 for PATs).

The page/data_source must be accessible by the workspace's PAT — the tool will return an error otherwise.

Returns counts and per-page indexing stats.`;

const FRIEND_DESCRIPTION = `Indexa uma página, database ou data_source do Notion no cérebro desta conta, sob demanda.

Aceita uma URL notion.so completa ou um ID de 32 hex. Tenta page → data_source → database (que expande para seus data_sources).

Use quando a pessoa compartilhar um link do Notion e quiser que ele fique pesquisável no brain_search imediatamente.

A página precisa estar acessível pelo Notion conectado desta conta — caso contrário a tool retorna erro.

Retorna contadores e estatísticas de indexação por página.`;

export async function registerBrainIndexUrlTool(
  server: McpServer,
  deps: BrainIndexUrlRegistrationDeps = defaultRegistrationDeps,
): Promise<void> {
  // #97 — the tool surface is built PER SESSION: the operator keeps the fixed
  // 3-workspace enum; a friend account gets an enum with ITS workspaces only.
  const owner = deps.isOwner();
  let workspaceSchema: z.ZodTypeAny = OPERATOR_WORKSPACE_SCHEMA;
  let hasWorkspaces = true;
  if (!owner) {
    const param = buildFriendWorkspaceParam(await deps.listWorkspaces(deps.getAccountId()));
    workspaceSchema = param.schema;
    hasWorkspaces = param.hasWorkspaces;
  }

  server.tool(
    "brain_index_url",
    owner ? OWNER_DESCRIPTION : FRIEND_DESCRIPTION,
    {
      workspace: workspaceSchema,
      url: z
        .string()
        .min(1)
        .describe("Full notion.so URL or 32-hex Notion ID (page, database, or data_source)"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe("Cap for data_source/database expansion (default 50)"),
    },
    async ({ workspace, url, max_pages }) => {
      // Friend without a connected Notion: clear runtime error (the schema
      // accepts the call so the user gets guidance instead of a zod failure).
      if (!hasWorkspaces) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "no_notion_workspace",
                message: NO_NOTION_WORKSPACE_MESSAGE,
              }),
            },
          ],
        };
      }

      // Security gate: enforce token workspace scope before any work.
      // No-op for bearer ("all") and for non-HTTP contexts (startup/cron/tests).
      // For a friend this also re-checks the workspace against the account's
      // scopes resolved by the auth layer (defense in depth vs the enum).
      assertWorkspaceScope(workspace as Workspace);

      // Fase 3 billing — on-demand indexing gated by plan (Free = off) + daily
      // page cap. Owner/default exempt. Pre-check vs requested max_pages; record
      // actual pages indexed after each success.
      const accountId = getAccountId();
      try {
        await assertOnDemandWithinLimit(accountId, max_pages);
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "quota_exceeded", message: e.message }) }] };
        }
        throw e;
      }

      const id = extractNotionId(url);
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "could_not_parse_id",
                hint: "Expected a notion.so URL ending in -<32-hex> or a raw UUID.",
              }),
            },
          ],
        };
      }
      const ws = workspace as Workspace;

      // Try as page
      try {
        const page = (await notionFetch(ws, `/v1/pages/${id}`)) as any;
        const result = await indexSinglePage(ws, page, null);
        await recordUsage(accountId, "index_pages", 1);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                kind: "page",
                workspace: ws,
                id,
                ...result,
              }),
            },
          ],
        };
      } catch (e: any) {
        if (e.code !== "object_not_found") {
          // Auth or other error: surface it
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  kind: "page",
                  error: e.code ?? "unknown",
                  message: e.message,
                }),
              },
            ],
          };
        }
      }

      // Try as data_source
      try {
        const ds = (await notionFetch(ws, `/v1/data_sources/${id}`)) as any;
        const dsName =
          ds.title?.map((t: any) => t.plain_text ?? "").join("") || "(untitled)";
        const { pages, truncated } = await indexDataSource(ws, id, dsName, max_pages);
        const total_chunks = pages.reduce((sum, p) => sum + p.chunks, 0);
        await recordUsage(accountId, "index_pages", pages.length);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                kind: "data_source",
                workspace: ws,
                id,
                data_source_name: dsName,
                pages_indexed: pages.length,
                total_chunks,
                truncated,
                hint_for_persistence: truncated
                  ? "Add this data_source id to NOTION_EXTRA_DATA_SOURCES env to keep it covered by hourly indexer ticks."
                  : undefined,
                pages,
              }),
            },
          ],
        };
      } catch (e: any) {
        if (e.code !== "object_not_found") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  kind: "data_source",
                  error: e.code ?? "unknown",
                  message: e.message,
                }),
              },
            ],
          };
        }
      }

      // Try as database (container) — pick first data_source and index it
      try {
        const db = (await notionFetch(ws, `/v1/databases/${id}`)) as any;
        const dsId: string | undefined = db.data_sources?.[0]?.id;
        const dsName: string =
          db.data_sources?.[0]?.name ||
          db.title?.map((t: any) => t.plain_text ?? "").join("") ||
          "(untitled)";
        if (!dsId) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  kind: "database",
                  error: "no_data_sources",
                }),
              },
            ],
          };
        }
        const { pages, truncated } = await indexDataSource(ws, dsId, dsName, max_pages);
        const total_chunks = pages.reduce((sum, p) => sum + p.chunks, 0);
        await recordUsage(accountId, "index_pages", pages.length);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                kind: "database",
                workspace: ws,
                id,
                resolved_data_source_id: dsId,
                data_source_name: dsName,
                pages_indexed: pages.length,
                total_chunks,
                truncated,
                pages,
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
                error: "not_found_as_page_data_source_or_database",
                last_error: e.message,
                id,
              }),
            },
          ],
        };
      }
    },
  );
}
