// src/rag/notion-source.ts
import { Client as NotionClient } from "@notionhq/client";
import { createHash } from "node:crypto";
import { NOTION_API_VERSION, notionFetch } from "../clients.js";
import type { IndexableDocument, Workspace } from "./types.js";

interface FetchOpts {
  workspace: Workspace;
  notionToken: string;
  modifiedSince?: Date;
  databaseIds?: string[];
}

interface DiscoveredDb {
  // data_source id (used by /v1/data_sources/{id}/query under API 2025-09-03)
  id: string;
  name: string;
}

async function discoverDatabases(notion: NotionClient): Promise<DiscoveredDb[]> {
  const dbs: DiscoveredDb[] = [];
  let cursor: string | undefined = undefined;
  do {
    const resp = await notion.search({
      filter: { property: "object", value: "data_source" as any },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const r of resp.results) {
      if ((r as any).object !== "data_source") continue;
      const titleProp = (r as any).title?.map((t: any) => t.plain_text).join("") ?? "(untitled)";
      dbs.push({ id: r.id, name: titleProp });
    }
    cursor = resp.next_cursor ?? undefined;
  } while (cursor);
  return dbs;
}

export async function* fetchWorkspaceDocuments(
  opts: FetchOpts,
): AsyncGenerator<IndexableDocument> {
  const notion = new NotionClient({ auth: opts.notionToken, notionVersion: NOTION_API_VERSION });
  const dbs: DiscoveredDb[] = opts.databaseIds
    ? opts.databaseIds.map((id) => ({ id, name: "Custom" }))
    : await discoverDatabases(notion);

  console.log(`[notion-source] workspace=${opts.workspace} discovered ${dbs.length} data sources`);

  for (const db of dbs) {
    try {
      let cursor: string | undefined = undefined;
      do {
        const body: Record<string, unknown> = {
          page_size: 50,
          ...(cursor ? { start_cursor: cursor } : {}),
          ...(opts.modifiedSince
            ? {
                filter: {
                  timestamp: "last_edited_time",
                  last_edited_time: { on_or_after: opts.modifiedSince.toISOString() },
                },
              }
            : {}),
        };
        const resp = (await notionFetch(opts.workspace, `/v1/data_sources/${db.id}/query`, {
          method: "POST",
          body,
        })) as { results: any[]; next_cursor: string | null };
        for (const page of resp.results) {
          if (!("properties" in page)) continue;
          try {
            const text = await pageToText(notion, page);
            if (!text.trim()) continue;
            yield {
              source_type: "notion",
              source_id: page.id,
              workspace: opts.workspace,
              db_name: db.name,
              parent_url: (page as any).url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
              text,
              metadata: extractMetadata(page),
              source_updated: new Date((page as any).last_edited_time),
            };
          } catch (pageErr: any) {
            console.warn(`[notion-source] skipped page ${page.id} in "${db.name}": ${pageErr.message ?? pageErr}`);
          }
        }
        cursor = resp.next_cursor ?? undefined;
      } while (cursor);
    } catch (dbErr: any) {
      console.warn(`[notion-source] skipped database "${db.name}" (${db.id}): ${dbErr.message ?? dbErr}`);
    }
  }
}

// Backwards compat alias for any external caller
export const fetchPersonalDocuments = fetchWorkspaceDocuments;

async function pageToText(notion: NotionClient, page: any): Promise<string> {
  const lines: string[] = [];
  for (const [, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      lines.push("# " + prop.title.map((t: any) => t.plain_text).join(""));
    }
  }
  for (const [name, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "rich_text" && prop.rich_text?.length) {
      const txt = prop.rich_text.map((t: any) => t.plain_text).join("");
      if (txt.trim()) lines.push(`**${name}:** ${txt}`);
    } else if (prop.type === "select" && prop.select?.name) {
      lines.push(`**${name}:** ${prop.select.name}`);
    } else if (prop.type === "multi_select" && prop.multi_select?.length) {
      lines.push(`**${name}:** ${prop.multi_select.map((s: any) => s.name).join(", ")}`);
    }
  }
  let cursor: string | undefined = undefined;
  do {
    const blocks = await notion.blocks.children.list({
      block_id: page.id,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of blocks.results) {
      const txt = blockText(b);
      if (txt) lines.push(txt);
    }
    cursor = blocks.next_cursor ?? undefined;
  } while (cursor);
  return lines.join("\n\n");
}

function blockText(block: any): string {
  const t = block.type;
  const data = block[t];
  if (!data) return "";
  const text = (data.rich_text ?? [])
    .map((r: any) => r.plain_text)
    .join("");
  if (!text.trim()) return "";
  switch (t) {
    case "heading_1":
      return "# " + text;
    case "heading_2":
      return "## " + text;
    case "heading_3":
      return "### " + text;
    case "bulleted_list_item":
    case "numbered_list_item":
      return "- " + text;
    case "to_do":
      return (data.checked ? "[x] " : "[ ] ") + text;
    case "toggle":
    case "callout":
    case "quote":
    case "paragraph":
    default:
      return text;
  }
}

function extractMetadata(page: any): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "select" && prop.select?.name) meta[name.toLowerCase()] = prop.select.name;
    else if (prop.type === "multi_select")
      meta[name.toLowerCase()] = prop.multi_select?.map((s: any) => s.name) ?? [];
    else if (prop.type === "date" && prop.date?.start) meta["data"] = prop.date.start;
    else if (prop.type === "people" && prop.people?.length)
      meta["pessoas"] = prop.people.map((p: any) => p.name).filter(Boolean);
  }
  if (Array.isArray(meta["frentes"]) && !meta["frente"]) meta["frente"] = (meta["frentes"] as string[])[0];
  return meta;
}

export function chunkId(sourceId: string, chunkIndex: number): string {
  return createHash("sha1").update(`${sourceId}:${chunkIndex}`).digest("hex");
}
