// src/rag/notion-source.ts
import { Client as NotionClient } from "@notionhq/client";
import { createHash } from "node:crypto";
import type { IndexableDocument, Workspace } from "./types.js";

interface FetchOpts {
  workspace: Workspace;
  notionToken: string;
  modifiedSince?: Date;
  databaseIds?: string[];
}

const DEFAULT_DATABASES_PERSONAL: { id: string; name: string }[] = [
  { id: "160d4836-53f1-41a3-b20a-0aaa42adb9cd", name: "Diario Semanal" },
  { id: "33a07ba5-bee8-81ed-acfb-ffdadfab353f", name: "Reunioes" },
  { id: "33a07ba5-bee8-81a4-b929-c8bc631ccba5", name: "Insights" },
  { id: "d5650545-161f-4d32-a706-360a9a5b7af2", name: "Decisoes" },
  { id: "33a07ba5-bee8-8143-8f06-e95be84ab113", name: "Projetos" },
  { id: "33a07ba5-bee8-81ff-bec4-eeb4234688f1", name: "Pessoas" },
  { id: "33a07ba5-bee8-813f-a58f-f0fe1055eec4", name: "Organizacoes" },
  { id: "33d07ba5-bee8-812c-9563-fc48b665e2f1", name: "Academia" },
  { id: "30d07ba5-bee8-8054-b8e4-d76a35b476b5", name: "Tasks Tracker" },
];

export async function* fetchPersonalDocuments(
  opts: FetchOpts,
): AsyncGenerator<IndexableDocument> {
  const notion = new NotionClient({ auth: opts.notionToken });
  const dbs =
    opts.databaseIds?.map((id) => ({ id, name: "Custom" })) ?? DEFAULT_DATABASES_PERSONAL;

  for (const db of dbs) {
    let cursor: string | undefined = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: db.id,
        start_cursor: cursor,
        page_size: 50,
        ...(opts.modifiedSince
          ? {
              filter: {
                timestamp: "last_edited_time",
                last_edited_time: { on_or_after: opts.modifiedSince.toISOString() },
              } as any,
            }
          : {}),
      });
      for (const page of resp.results) {
        if (!("properties" in page)) continue;
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
      }
      cursor = resp.next_cursor ?? undefined;
    } while (cursor);
  }
}

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
