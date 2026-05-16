import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient, notionFetch, type Workspace } from "./clients.js";
import { auditWrite } from "./audit.js";
import {
  markdownToBlocks,
  blocksToMarkdown,
  schemaToMarkdown,
  propertiesToMarkdown,
} from "./markdown.js";

const NORA_READONLY = process.env.NORA_READONLY === "true";

const DESTRUCTIVE_CONFIRM_NOTE =
  " Requires confirm:true since this operation is destructive and irreversible without a backup.";

const workspaceSchema = z
  .enum(["globalcripto", "personal", "nora"])
  .describe("The Notion workspace to use");

const notionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i,
    "Must be a valid Notion UUID"
  );

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function text(result: string) {
  return {
    content: [{ type: "text" as const, text: result }],
  };
}

/** Recursively fetch all block children (handles pagination). */
async function fetchAllBlocks(
  client: ReturnType<typeof getClient>,
  blockId: string
): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...(resp.results as Record<string, unknown>[]));
    cursor = resp.has_more ? (resp.next_cursor as string) : undefined;
  } while (cursor);

  return blocks;
}

/** Normalise a Notion URL or raw ID into a UUID. */
function parseNotionId(input: string): string {
  // Handle full URLs
  const urlMatch = input.match(
    /(?:notion\.so|notion\.site)\/(?:.*[-/])?([\da-f]{32})/i
  );
  if (urlMatch) {
    const raw = urlMatch[1];
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  // Already a UUID with dashes
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(input)) {
    return input;
  }
  // Raw 32-char hex
  if (/^[\da-f]{32}$/i.test(input)) {
    return `${input.slice(0, 8)}-${input.slice(8, 12)}-${input.slice(12, 16)}-${input.slice(16, 20)}-${input.slice(20)}`;
  }
  return input; // return as-is, let Notion API error
}

export function registerTools(server: McpServer): void {
  // Wrap server.tool to add error logging to every handler without touching each one.
  const origTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = function wrappedTool(
    name: string,
    desc: string,
    schema: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: any) => Promise<unknown>
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async (args: any, extra: any) => {
      try {
        return await handler(args, extra);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = String((err as Record<string, unknown>)?.code ?? "");
        const reqId = String((err as Record<string, unknown>)?.request_id ?? "");
        console.error(
          `[${new Date().toISOString()}] tool error [${name}]` +
            ` workspace=${String((args as Record<string, unknown>)?.workspace ?? "?")}` +
            ` code=${code} request_id=${reqId} msg=${msg}`
        );
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origTool as any)(name, desc, schema, wrapped);
  };
  // ── Existing tools ───────────────────────────────────────────────────────

  server.tool(
    "notion_search",
    "Search pages and databases in a Notion workspace",
    {
      workspace: workspaceSchema,
      query: z.string().describe("The text to search for"),
      filter: z
        .object({
          value: z.enum(["page", "database"]),
          property: z.literal("object"),
        })
        .optional()
        .describe("Filter results by object type"),
    },
    async ({ workspace, query, filter }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.search({
        query,
        ...(filter ? { filter } : {}),
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_get_page",
    "Retrieve a Notion page and its block children",
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page to retrieve"),
    },
    async ({ workspace, page_id }) => {
      const client = getClient(workspace as Workspace);
      const [page, blocks] = await Promise.all([
        client.pages.retrieve({ page_id }),
        client.blocks.children.list({ block_id: page_id }),
      ]);
      return ok({ page, blocks });
    }
  );

  server.tool(
    "notion_query_database",
    "Query a Notion database with optional filters and sorts. For multi-source databases, this falls back to a structured response listing the data sources — call notion_query_data_source on a specific one.",
    {
      workspace: workspaceSchema,
      database_id: notionIdSchema.describe("The ID of the database to query"),
      filter: z.record(z.unknown()).optional().describe("Notion filter object"),
      sorts: z
        .array(
          z.object({
            property: z.string(),
            direction: z.enum(["ascending", "descending"]),
          })
        )
        .optional()
        .describe("Sort configuration"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of results per page (1-100)"),
      start_cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response"),
    },
    async ({ workspace, database_id, filter, sorts, page_size, start_cursor }) => {
      const client = getClient(workspace as Workspace);
      try {
        const result = await client.databases.query({
          database_id,
          ...(filter ? { filter: filter as Parameters<typeof client.databases.query>[0]["filter"] } : {}),
          ...(sorts ? { sorts: sorts as Parameters<typeof client.databases.query>[0]["sorts"] } : {}),
          ...(page_size ? { page_size } : {}),
          ...(start_cursor ? { start_cursor } : {}),
        });
        return ok(result);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "multiple_data_sources_for_database") {
          const dbResp = (await notionFetch(workspace as Workspace, `/v1/databases/${database_id}`)) as {
            data_sources?: Array<{ id: string; name: string }>;
            title?: Array<{ plain_text: string }>;
          };
          return ok({
            error: "multiple_data_sources_for_database",
            message:
              "This database has multiple data sources. Use notion_query_data_source with one of the data_source_id values below.",
            database_id,
            title: dbResp.title?.map((t) => t.plain_text).join("") ?? "",
            data_sources: dbResp.data_sources ?? [],
            next_tool: "notion_query_data_source",
          });
        }
        throw err;
      }
    }
  );

  server.tool(
    "notion_create_page",
    "Create a new page in a Notion workspace. Accepts either raw block children or a Markdown content string.",
    {
      workspace: workspaceSchema,
      parent: z
        .record(z.unknown())
        .describe("Parent object: { type: 'database_id', database_id: '...' } or { type: 'page_id', page_id: '...' }"),
      properties: z
        .record(z.unknown())
        .describe("Page properties matching the parent database schema"),
      children: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Initial block content for the page (raw Notion blocks)"),
      content: z
        .string()
        .optional()
        .describe("Markdown content string — converted to blocks automatically. Ignored if children is provided."),
    },
    async ({ workspace, parent, properties, children, content }) => {
      const client = getClient(workspace as Workspace);

      let blocks = children;
      if (!blocks && content) {
        blocks = markdownToBlocks(content) as Parameters<typeof client.pages.create>[0]["children"];
      }

      const result = await client.pages.create({
        parent: parent as Parameters<typeof client.pages.create>[0]["parent"],
        properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
        ...(blocks
          ? { children: blocks as Parameters<typeof client.pages.create>[0]["children"] }
          : {}),
      });
      auditWrite("notion_create_page", workspace, {
        parent: JSON.stringify(parent),
        new_page_id: (result as { id?: string }).id,
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_update_page",
    "Update properties of an existing Notion page",
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page to update"),
      properties: z
        .record(z.unknown())
        .describe("Properties to update"),
    },
    async ({ workspace, page_id, properties }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.pages.update({
        page_id,
        properties: properties as Parameters<typeof client.pages.update>[0]["properties"],
      });
      auditWrite("notion_update_page", workspace, { page_id });
      return ok(result);
    }
  );

  server.tool(
    "notion_append_blocks",
    "Append block children to a Notion page or block. Accepts raw blocks or Markdown.",
    {
      workspace: workspaceSchema,
      block_id: notionIdSchema.describe("The ID of the page or block to append to"),
      children: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Array of block objects to append (raw Notion blocks)"),
      content: z
        .string()
        .optional()
        .describe("Markdown content to append — converted to blocks automatically. Ignored if children is provided."),
    },
    async ({ workspace, block_id, children, content }) => {
      const client = getClient(workspace as Workspace);

      let blocks = children;
      if (!blocks && content) {
        blocks = markdownToBlocks(content);
      }

      if (!blocks || blocks.length === 0) {
        return text("Error: either children or content must be provided.");
      }

      const result = await client.blocks.children.append({
        block_id,
        children: blocks as Parameters<typeof client.blocks.children.append>[0]["children"],
      });
      auditWrite("notion_append_blocks", workspace, { block_id });
      return ok(result);
    }
  );

  server.tool(
    "notion_get_database_schema",
    "Retrieve the schema/structure of a Notion database. For multi-source databases, returns the list of data sources — call notion_get_data_source_schema on each to inspect properties.",
    {
      workspace: workspaceSchema,
      database_id: notionIdSchema.describe("The ID of the database"),
    },
    async ({ workspace, database_id }) => {
      const client = getClient(workspace as Workspace);
      try {
        const result = await client.databases.retrieve({ database_id });
        return ok(result);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "multiple_data_sources_for_database") {
          const dbResp = (await notionFetch(workspace as Workspace, `/v1/databases/${database_id}`)) as {
            data_sources?: Array<{ id: string; name: string }>;
            title?: Array<{ plain_text: string }>;
          };
          return ok({
            multi_source: true,
            database_id,
            title: dbResp.title?.map((t) => t.plain_text).join("") ?? "",
            data_sources: dbResp.data_sources ?? [],
            next_tool: "notion_get_data_source_schema",
          });
        }
        throw err;
      }
    }
  );

  server.tool(
    "notion_list_users",
    "List all users in a Notion workspace",
    {
      workspace: workspaceSchema,
    },
    async ({ workspace }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.users.list({});
      return ok(result);
    }
  );

  // ── P1: Create & Update Database ─────────────────────────────────────────

  server.tool(
    "notion_create_database",
    "Create a new database inside a parent page with a given schema",
    {
      workspace: workspaceSchema,
      parent_page_id: notionIdSchema.describe("The ID of the parent page"),
      title: z.string().describe("Database title"),
      schema: z
        .record(z.record(z.unknown()))
        .describe(
          'Database properties schema. Keys are property names, values are Notion property configs. Example: { "Name": { "title": {} }, "Status": { "select": { "options": [{ "name": "Todo" }, { "name": "Done" }] } }, "Due": { "date": {} } }'
        ),
    },
    async ({ workspace, parent_page_id, title, schema }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.databases.create({
        parent: { type: "page_id", page_id: parent_page_id },
        title: [{ type: "text", text: { content: title } }],
        properties: schema as Parameters<typeof client.databases.create>[0]["properties"],
      });
      auditWrite("notion_create_database", workspace, {
        parent_page_id,
        title,
        new_database_id: (result as { id?: string }).id,
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_update_database",
    "Update a database: add, rename, or remove columns. Also supports updating title and description. Removing columns deletes ALL data in those columns across every row — requires confirm:true.",
    {
      workspace: workspaceSchema,
      database_id: notionIdSchema.describe("The ID of the database to update"),
      title: z.string().optional().describe("New database title"),
      description: z.string().optional().describe("New database description"),
      add_columns: z
        .record(z.record(z.unknown()))
        .optional()
        .describe('New columns to add. Example: { "Priority": { "select": { "options": [{ "name": "High" }, { "name": "Low" }] } } }'),
      rename_columns: z
        .record(z.string())
        .optional()
        .describe('Columns to rename. Example: { "Old Name": "New Name" }'),
      remove_columns: z
        .array(z.string())
        .optional()
        .describe("Column names to remove. Wipes all values in those columns across every row."),
      confirm: z
        .literal(true)
        .optional()
        .describe("Required when remove_columns is set. Caller acknowledges data loss."),
    },
    async ({ workspace, database_id, title, description, add_columns, rename_columns, remove_columns, confirm }) => {
      if (remove_columns && remove_columns.length > 0 && confirm !== true) {
        return text(
          `Refusing: removing columns (${remove_columns.join(", ")}) deletes data in every row. Pass confirm: true to proceed.`
        );
      }
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to update: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const client = getClient(workspace as Workspace);

      const properties: Record<string, unknown> = {};

      // Add new columns
      if (add_columns) {
        for (const [name, config] of Object.entries(add_columns)) {
          properties[name] = config;
        }
      }

      // Rename columns: set new name via the `name` field
      if (rename_columns) {
        for (const [oldName, newName] of Object.entries(rename_columns)) {
          properties[oldName] = { name: newName };
        }
      }

      // Remove columns: set to null
      if (remove_columns) {
        for (const col of remove_columns) {
          properties[col] = null;
        }
      }

      const result = await client.databases.update({
        database_id,
        ...(title
          ? { title: [{ type: "text" as const, text: { content: title } }] }
          : {}),
        ...(description !== undefined
          ? { description: [{ type: "text" as const, text: { content: description } }] }
          : {}),
        ...(Object.keys(properties).length > 0
          ? { properties: properties as Parameters<typeof client.databases.update>[0]["properties"] }
          : {}),
      });
      auditWrite("notion_update_database", workspace, {
        database_id,
        added: add_columns ? Object.keys(add_columns) : [],
        renamed: rename_columns ? Object.keys(rename_columns) : [],
        removed: remove_columns ?? [],
      });
      return ok(result);
    }
  );

  // ── P2: Rich Fetch ───────────────────────────────────────────────────────

  server.tool(
    "notion_fetch",
    "Fetch a page or database by URL or ID. Returns structured Markdown content, properties, and schema (for databases).",
    {
      workspace: workspaceSchema,
      id: z
        .string()
        .describe("Notion page/database URL or ID"),
    },
    async ({ workspace, id }) => {
      const client = getClient(workspace as Workspace);
      const objectId = parseNotionId(id);

      // Try as database first, then page
      try {
        const db = await client.databases.retrieve({ database_id: objectId });
        const dbAny = db as Record<string, unknown>;
        const titleArr = (dbAny.title as Array<{ plain_text: string }>) ?? [];
        const titleText = titleArr.map((t) => t.plain_text).join("");
        const props = dbAny.properties as Record<string, Record<string, unknown>>;

        const parts: string[] = [
          `# ${titleText}`,
          `**Type:** Database`,
          `**ID:** ${dbAny.id}`,
          `**URL:** ${dbAny.url}`,
          "",
          schemaToMarkdown(props),
        ];

        // Fetch first few entries for context
        const entries = await client.databases.query({
          database_id: objectId,
          page_size: 5,
        });

        if (entries.results.length > 0) {
          parts.push("", "## Recent Entries", "");
          for (const entry of entries.results) {
            const entryAny = entry as Record<string, unknown>;
            const entryProps = entryAny.properties as Record<string, Record<string, unknown>>;
            const entryTitle = Object.values(entryProps).find(
              (p) => p.type === "title"
            );
            const titleRt = entryTitle?.title as Array<{ plain_text: string }> | undefined;
            const name = titleRt?.map((t) => t.plain_text).join("") ?? "(untitled)";
            parts.push(`### ${name}`, propertiesToMarkdown(entryProps), "");
          }
        }

        return text(parts.join("\n"));
      } catch {
        // Not a database — try as page
      }

      const page = await client.pages.retrieve({ page_id: objectId });
      const pageAny = page as Record<string, unknown>;
      const pageProps = pageAny.properties as Record<string, Record<string, unknown>>;

      // Get title
      const titleProp = Object.values(pageProps).find((p) => p.type === "title");
      const titleRt = titleProp?.title as Array<{ plain_text: string }> | undefined;
      const pageTitle = titleRt?.map((t) => t.plain_text).join("") ?? "(untitled)";

      // Fetch all blocks
      const blocks = await fetchAllBlocks(client, objectId);
      const markdown = blocksToMarkdown(blocks as Record<string, unknown>[]);

      const parts: string[] = [
        `# ${pageTitle}`,
        `**Type:** Page`,
        `**ID:** ${pageAny.id}`,
        `**URL:** ${pageAny.url}`,
        "",
      ];

      const propsMarkdown = propertiesToMarkdown(pageProps);
      if (propsMarkdown) {
        parts.push("## Properties", propsMarkdown, "");
      }

      parts.push("## Content", "", markdown);

      return text(parts.join("\n"));
    }
  );

  // ── P3: Update Page Content ──────────────────────────────────────────────

  server.tool(
    "notion_update_page_content",
    "Edit specific parts of a page's content using search-and-replace on the Markdown representation. Finds the block(s) containing old_str and replaces with new_str.",
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page to edit"),
      old_str: z.string().describe("Text to find in the page content"),
      new_str: z.string().describe("Replacement text"),
    },
    async ({ workspace, page_id, old_str, new_str }) => {
      const client = getClient(workspace as Workspace);
      const blocks = await fetchAllBlocks(client, page_id);

      let replacements = 0;

      for (const block of blocks) {
        const type = block.type as string;
        const data = block[type] as Record<string, unknown> | undefined;
        if (!data?.rich_text) continue;

        const rt = data.rich_text as Array<{
          type: string;
          text: { content: string; link: { url: string } | null };
          annotations: Record<string, unknown>;
          plain_text: string;
        }>;

        const fullText = rt.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
        if (!fullText.includes(old_str)) continue;

        // Build new rich_text with replacement
        const newRt = rt.map((t) => {
          const content = t.text?.content ?? t.plain_text ?? "";
          if (content.includes(old_str)) {
            return {
              ...t,
              text: {
                ...t.text,
                content: content.replace(old_str, new_str),
              },
            };
          }
          return t;
        });

        await client.blocks.update({
          block_id: block.id as string,
          [type]: { rich_text: newRt },
        });
        replacements++;
      }

      if (replacements === 0) {
        return text(`No blocks found containing "${old_str}".`);
      }

      auditWrite("notion_update_page_content", workspace, {
        page_id,
        replacements,
      });
      return text(`Replaced in ${replacements} block(s).`);
    }
  );

  server.tool(
    "notion_replace_page_content",
    "DESTRUCTIVE: replace the entire content of a page. Deletes all existing blocks and appends new content from Markdown or raw blocks." +
      DESTRUCTIVE_CONFIRM_NOTE,
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page"),
      children: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("New block content (raw Notion blocks)"),
      content: z
        .string()
        .optional()
        .describe("New content as Markdown — converted to blocks automatically. Ignored if children is provided."),
      confirm: z
        .literal(true)
        .describe("Must be true. Caller acknowledges this deletes all existing blocks on the page."),
    },
    async ({ workspace, page_id, children, content, confirm }) => {
      if (confirm !== true) {
        return text(
          "Refusing: notion_replace_page_content requires confirm: true. This operation deletes every existing block on the page before appending the new content."
        );
      }
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to replace: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const client = getClient(workspace as Workspace);

      let newBlocks = children;
      if (!newBlocks && content) {
        newBlocks = markdownToBlocks(content);
      }

      if (!newBlocks || newBlocks.length === 0) {
        return text("Error: either children or content must be provided.");
      }

      // Delete all existing blocks
      const existing = await fetchAllBlocks(client, page_id);
      for (const block of existing) {
        await client.blocks.delete({ block_id: block.id as string });
      }

      // Append new content
      const result = await client.blocks.children.append({
        block_id: page_id,
        children: newBlocks as Parameters<typeof client.blocks.children.append>[0]["children"],
      });

      auditWrite("notion_replace_page_content", workspace, {
        page_id,
        deleted_blocks: existing.length,
      });
      return ok(result);
    }
  );

  // ── P5: Delete & Move Page ───────────────────────────────────────────────

  server.tool(
    "notion_delete_page",
    "DESTRUCTIVE: move a page to trash (archive it). The page becomes invisible in the UI and inaccessible via most tools." +
      DESTRUCTIVE_CONFIRM_NOTE,
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page to delete"),
      confirm: z
        .literal(true)
        .describe("Must be true. Caller acknowledges archiving this page."),
    },
    async ({ workspace, page_id, confirm }) => {
      if (confirm !== true) {
        return text(
          "Refusing: notion_delete_page requires confirm: true. Archive moves the page to trash (recoverable for 30 days, then permanent)."
        );
      }
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to delete: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const client = getClient(workspace as Workspace);
      const result = await client.pages.update({
        page_id,
        archived: true,
      });
      auditWrite("notion_delete_page", workspace, { page_id });
      return ok(result);
    }
  );

  server.tool(
    "notion_move_page",
    "Move a page to a different parent (page or database). Note: uses Notion's block API to reparent.",
    {
      workspace: workspaceSchema,
      page_id: notionIdSchema.describe("The ID of the page to move"),
      new_parent_id: notionIdSchema.describe(
        "The ID of the new parent page or database"
      ),
      parent_type: z
        .enum(["page_id", "database_id"])
        .default("page_id")
        .describe("Type of the new parent"),
    },
    async ({ workspace, page_id, new_parent_id, parent_type }) => {
      const client = getClient(workspace as Workspace);

      // Notion API doesn't have a direct "move" endpoint.
      // We use the page update with parent field (supported since API 2023-08-01).
      const result = await client.pages.update({
        page_id,
        // @ts-expect-error — parent update is supported but types may lag
        parent: { type: parent_type, [parent_type]: new_parent_id },
      });
      auditWrite("notion_move_page", workspace, {
        page_id,
        new_parent_id,
        parent_type,
      });
      return ok(result);
    }
  );

  // ── Data sources (multi-source databases, API 2025-09-03) ────────────────

  server.tool(
    "notion_list_data_sources",
    "List the data sources of a Notion database. Multi-source databases expose multiple data sources under a single container; use this to discover them, then call notion_query_data_source on a specific one.",
    {
      workspace: workspaceSchema,
      database_id: notionIdSchema.describe("The container database ID"),
    },
    async ({ workspace, database_id }) => {
      const db = (await notionFetch(workspace as Workspace, `/v1/databases/${database_id}`)) as {
        data_sources?: Array<{ id: string; name: string }>;
        title?: Array<{ plain_text: string }>;
      };
      return ok({
        database_id,
        title: db.title?.map((t) => t.plain_text).join("") ?? "",
        data_sources: db.data_sources ?? [],
      });
    }
  );

  server.tool(
    "notion_get_data_source_schema",
    "Get the schema (properties) of a specific data source within a multi-source database.",
    {
      workspace: workspaceSchema,
      data_source_id: notionIdSchema.describe("The data source ID"),
    },
    async ({ workspace, data_source_id }) => {
      const ds = await notionFetch(workspace as Workspace, `/v1/data_sources/${data_source_id}`);
      return ok(ds);
    }
  );

  server.tool(
    "notion_query_data_source",
    "Query a specific data source within a multi-source database. Same filter/sort semantics as notion_query_database.",
    {
      workspace: workspaceSchema,
      data_source_id: notionIdSchema.describe("The data source ID to query"),
      filter: z.record(z.unknown()).optional().describe("Notion filter object"),
      sorts: z
        .array(
          z.object({
            property: z.string(),
            direction: z.enum(["ascending", "descending"]),
          })
        )
        .optional(),
      page_size: z.number().int().min(1).max(100).optional(),
      start_cursor: z.string().optional(),
    },
    async ({ workspace, data_source_id, filter, sorts, page_size, start_cursor }) => {
      const body: Record<string, unknown> = {};
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (page_size) body.page_size = page_size;
      if (start_cursor) body.start_cursor = start_cursor;
      const result = await notionFetch(
        workspace as Workspace,
        `/v1/data_sources/${data_source_id}/query`,
        { method: "POST", body }
      );
      return ok(result);
    }
  );

  // ── Comments (Notion-Version 2022-06-28+, fully usable via PAT) ──────────

  server.tool(
    "notion_list_comments",
    "List unresolved comments on a Notion page or block.",
    {
      workspace: workspaceSchema,
      block_id: notionIdSchema.describe("Page or block ID"),
      page_size: z.number().int().min(1).max(100).optional(),
      start_cursor: z.string().optional(),
    },
    async ({ workspace, block_id, page_size, start_cursor }) => {
      const result = await notionFetch(workspace as Workspace, "/v1/comments", {
        query: { block_id, page_size, start_cursor },
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_create_comment",
    "Add a comment on a page or to an existing discussion thread.",
    {
      workspace: workspaceSchema,
      parent: z
        .union([
          z.object({ page_id: notionIdSchema }),
          z.object({ discussion_id: z.string() }),
        ])
        .describe(
          "Either { page_id } to start a new comment on a page, or { discussion_id } to reply to an existing thread"
        ),
      rich_text: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Notion rich text array. Use this OR text."),
      text: z
        .string()
        .optional()
        .describe("Plain text comment (auto-wrapped into rich_text)."),
    },
    async ({ workspace, parent, rich_text, text: textBody }) => {
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to comment: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const rt =
        rich_text ??
        (textBody !== undefined
          ? [{ type: "text", text: { content: textBody } }]
          : undefined);
      if (!rt || rt.length === 0) {
        return text("Error: either rich_text or text must be provided.");
      }
      const result = await notionFetch(workspace as Workspace, "/v1/comments", {
        method: "POST",
        body: { parent, rich_text: rt },
      });
      auditWrite("notion_create_comment", workspace, {
        parent: JSON.stringify(parent),
      });
      return ok(result);
    }
  );

  // ── File uploads (Notion's new file_uploads API) ─────────────────────────

  server.tool(
    "notion_create_file_upload",
    "Start a Notion file upload session. Returns a file_upload object whose id can be used as block content. Most uploads use mode 'single_part' — call notion_send_file_upload next with the file bytes.",
    {
      workspace: workspaceSchema,
      filename: z.string().describe("Display name for the file"),
      content_type: z
        .string()
        .optional()
        .describe("MIME type, e.g. 'image/png' or 'application/pdf'"),
      mode: z
        .enum(["single_part", "multi_part", "external_url"])
        .default("single_part")
        .describe("single_part for files ≤20MB; multi_part for larger; external_url to pull from a URL"),
      number_of_parts: z
        .number()
        .int()
        .min(2)
        .max(1000)
        .optional()
        .describe("Required when mode='multi_part'"),
      external_url: z
        .string()
        .optional()
        .describe("Required when mode='external_url'"),
    },
    async ({ workspace, filename, content_type, mode, number_of_parts, external_url }) => {
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to upload: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const body: Record<string, unknown> = { filename, mode };
      if (content_type) body.content_type = content_type;
      if (mode === "multi_part") {
        if (!number_of_parts) {
          return text("Error: multi_part mode requires number_of_parts.");
        }
        body.number_of_parts = number_of_parts;
      }
      if (mode === "external_url") {
        if (!external_url) {
          return text("Error: external_url mode requires external_url.");
        }
        body.external_url = external_url;
      }
      const result = await notionFetch(workspace as Workspace, "/v1/file_uploads", {
        method: "POST",
        body,
      });
      auditWrite("notion_create_file_upload", workspace, { filename });
      return ok(result);
    }
  );

  server.tool(
    "notion_send_file_upload",
    "Send file bytes (base64-encoded) to an in-progress file upload session. For multi-part, pass part_number.",
    {
      workspace: workspaceSchema,
      file_upload_id: notionIdSchema.describe("ID returned by notion_create_file_upload"),
      file_base64: z.string().describe("File content encoded as base64"),
      filename: z.string().describe("Filename to include in the multipart form"),
      content_type: z
        .string()
        .default("application/octet-stream")
        .describe("MIME type of the file"),
      part_number: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Required for multi_part uploads"),
    },
    async ({ workspace, file_upload_id, file_base64, filename, content_type, part_number }) => {
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to upload: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const bytes = Buffer.from(file_base64, "base64");
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: content_type }), filename);
      if (part_number !== undefined) form.append("part_number", String(part_number));
      const result = await notionFetch(
        workspace as Workspace,
        `/v1/file_uploads/${file_upload_id}/send`,
        { method: "POST", rawBody: form }
      );
      auditWrite("notion_send_file_upload", workspace, {
        file_upload_id,
        bytes: bytes.length,
        part_number,
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_complete_file_upload",
    "Mark a multi_part file upload as complete after all parts have been sent.",
    {
      workspace: workspaceSchema,
      file_upload_id: notionIdSchema.describe("ID of the multi-part upload"),
    },
    async ({ workspace, file_upload_id }) => {
      if (NORA_READONLY && workspace === "nora") {
        throw new Error(
          "Refusing to upload: the 'nora' workspace is in read-only mode (NORA_READONLY=true)."
        );
      }
      const result = await notionFetch(
        workspace as Workspace,
        `/v1/file_uploads/${file_upload_id}/complete`,
        { method: "POST", body: {} }
      );
      auditWrite("notion_complete_file_upload", workspace, { file_upload_id });
      return ok(result);
    }
  );

  // ── Introspection ────────────────────────────────────────────────────────

  server.tool(
    "notion_get_self",
    "Return info about the token currently used for this workspace: integration/PAT name, owner, workspace name, workspace_id, and workspace upload limits.",
    {
      workspace: workspaceSchema,
    },
    async ({ workspace }) => {
      const me = await notionFetch(workspace as Workspace, "/v1/users/me");
      return ok(me);
    }
  );

  server.tool(
    "notion_get_block_children",
    "List the direct block children of a page or block (paginated). Use when you only need block IDs/types and want to avoid fetching the whole page.",
    {
      workspace: workspaceSchema,
      block_id: notionIdSchema.describe("Page or block ID"),
      page_size: z.number().int().min(1).max(100).optional(),
      start_cursor: z.string().optional(),
    },
    async ({ workspace, block_id, page_size, start_cursor }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.blocks.children.list({
        block_id,
        ...(page_size ? { page_size } : {}),
        ...(start_cursor ? { start_cursor } : {}),
      });
      return ok(result);
    }
  );
}
