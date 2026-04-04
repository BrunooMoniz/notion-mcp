import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient, type Workspace } from "./clients.js";

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

export function registerTools(server: McpServer): void {
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
    "Query a Notion database with optional filters and sorts",
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
    },
    async ({ workspace, database_id, filter, sorts, page_size }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.databases.query({
        database_id,
        ...(filter ? { filter: filter as Parameters<typeof client.databases.query>[0]["filter"] } : {}),
        ...(sorts ? { sorts: sorts as Parameters<typeof client.databases.query>[0]["sorts"] } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_create_page",
    "Create a new page in a Notion workspace",
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
        .describe("Initial block content for the page"),
    },
    async ({ workspace, parent, properties, children }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.pages.create({
        parent: parent as Parameters<typeof client.pages.create>[0]["parent"],
        properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
        ...(children
          ? { children: children as Parameters<typeof client.pages.create>[0]["children"] }
          : {}),
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
      return ok(result);
    }
  );

  server.tool(
    "notion_append_blocks",
    "Append block children to a Notion page or block",
    {
      workspace: workspaceSchema,
      block_id: notionIdSchema.describe("The ID of the page or block to append to"),
      children: z
        .array(z.record(z.unknown()))
        .describe("Array of block objects to append"),
    },
    async ({ workspace, block_id, children }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.blocks.children.append({
        block_id,
        children: children as Parameters<typeof client.blocks.children.append>[0]["children"],
      });
      return ok(result);
    }
  );

  server.tool(
    "notion_get_database_schema",
    "Retrieve the schema/structure of a Notion database",
    {
      workspace: workspaceSchema,
      database_id: notionIdSchema.describe("The ID of the database"),
    },
    async ({ workspace, database_id }) => {
      const client = getClient(workspace as Workspace);
      const result = await client.databases.retrieve({ database_id });
      return ok(result);
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
}
