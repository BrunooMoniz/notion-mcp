// src/classifier/notion-classifier.ts
// Orchestrates: fetch unclassified pages → LLM classify → apply props + relations on Notion.

import { Client as NotionClient } from "@notionhq/client";
import { classifyPage } from "./anthropic.js";
import type { ClassificationResult, PageToClassify } from "./types.js";

interface DbConfig {
  workspace: "personal" | "globalcripto" | "nora";
  envVar: string;
}

const PERSONAL_DBS = {
  Reunioes: "33a07ba5-bee8-81ed-acfb-ffdadfab353f",
  Insights: "33a07ba5-bee8-81a4-b929-c8bc631ccba5",
  Pessoas: "33a07ba5-bee8-81ff-bec4-eeb4234688f1",
  Organizacoes: "33a07ba5-bee8-813f-a58f-f0fe1055eec4",
} as const;

interface ClassifierStats {
  scanned: number;
  classified: number;
  pessoas_created: number;
  pessoas_linked: number;
  orgs_created: number;
  orgs_linked: number;
  errors: number;
  startedAt: Date;
  endedAt: Date;
}

export async function runClassifier(opts: { sinceDays?: number; limit?: number } = {}): Promise<ClassifierStats> {
  const stats: ClassifierStats = {
    scanned: 0,
    classified: 0,
    pessoas_created: 0,
    pessoas_linked: 0,
    orgs_created: 0,
    orgs_linked: 0,
    errors: 0,
    startedAt: new Date(),
    endedAt: new Date(),
  };

  const token = process.env.NOTION_PERSONAL_TOKEN;
  if (!token) throw new Error("NOTION_PERSONAL_TOKEN not set");
  const notion = new NotionClient({ auth: token });

  const sinceDays = opts.sinceDays ?? 7;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const limit = opts.limit ?? 50;

  // Pre-load existing Pessoas + Organizacoes for fuzzy matching
  const pessoasIndex = await loadEntityIndex(notion, PERSONAL_DBS.Pessoas);
  const orgsIndex = await loadEntityIndex(notion, PERSONAL_DBS.Organizacoes);

  let processed = 0;
  for (const dbName of ["Reunioes", "Insights"] as const) {
    const dbId = PERSONAL_DBS[dbName];
    const pages = await fetchUnclassified(notion, dbId, dbName, sinceIso, limit - processed);
    stats.scanned += pages.length;
    for (const page of pages) {
      if (processed >= limit) break;
      processed++;
      try {
        const result = await classifyPage(page);
        await applyClassification(notion, page, result, pessoasIndex, orgsIndex, stats);
        stats.classified++;
        console.log(
          `[classifier] ${dbName}/${page.page_id.slice(0, 8)}: frente=${result.frente ?? "-"} tipo=${result.tipo ?? "-"} cat=${result.categoria ?? "-"} pessoas=${result.pessoas.length} orgs=${result.organizacoes.length}`,
        );
      } catch (err: any) {
        stats.errors++;
        console.error(`[classifier] FAILED ${page.page_id}:`, err.message ?? err);
      }
    }
  }

  stats.endedAt = new Date();
  return stats;
}

interface EntityIndex {
  byNormalizedName: Map<string, string>; // normalized_name → page_id
  dbId: string;
}

async function loadEntityIndex(notion: NotionClient, dbId: string): Promise<EntityIndex> {
  const byNormalizedName = new Map<string, string>();
  let cursor: string | undefined = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of resp.results) {
      if (!("properties" in page)) continue;
      const titleProp = Object.values<any>(page.properties).find((p) => p.type === "title");
      const title = titleProp?.title?.map((t: any) => t.plain_text).join("") ?? "";
      if (title.trim()) {
        byNormalizedName.set(normalize(title), page.id);
      }
    }
    cursor = resp.next_cursor ?? undefined;
  } while (cursor);
  return { byNormalizedName, dbId };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchUnclassified(
  notion: NotionClient,
  dbId: string,
  dbName: "Reunioes" | "Insights",
  sinceIso: string,
  limit: number,
): Promise<PageToClassify[]> {
  if (limit <= 0) return [];
  const resp = await notion.databases.query({
    database_id: dbId,
    page_size: Math.min(limit, 50),
    filter: {
      timestamp: "created_time",
      created_time: { on_or_after: sinceIso },
    } as any,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  });

  const results: PageToClassify[] = [];
  for (const page of resp.results) {
    if (!("properties" in page)) continue;
    const props = page.properties;
    const current = {
      frente: ((props as any).Frente?.select?.name) ?? null,
      tipo: ((props as any).Tipo?.select?.name) ?? null,
      categoria: ((props as any).Categoria?.select?.name) ?? null,
      fonte_tipo: ((props as any)["Fonte Tipo"]?.select?.name) ?? null,
    };

    if (dbName === "Reunioes") {
      if (current.frente && current.tipo) continue; // already classified
    } else {
      if (current.categoria) continue;
    }

    const titleProp = Object.values<any>(props).find((p) => p.type === "title");
    const title = titleProp?.title?.map((t: any) => t.plain_text).join("") ?? "";
    const body = await pageBody(notion, page.id, props);
    if (!title && !body) continue;

    results.push({
      page_id: page.id,
      workspace: "personal",
      db: dbName,
      title,
      body,
      current_props: current,
    });
  }
  return results;
}

async function pageBody(notion: NotionClient, pageId: string, props: any): Promise<string> {
  const lines: string[] = [];
  // Useful text props (Resumo, Action Items, Detalhes, etc.)
  for (const [name, prop] of Object.entries<any>(props)) {
    if (prop.type === "rich_text" && prop.rich_text?.length) {
      const txt = prop.rich_text.map((t: any) => t.plain_text).join("");
      if (txt.trim()) lines.push(`**${name}:** ${txt}`);
    }
  }
  // Body blocks (cap at 30 to keep prompt small)
  let cursor: string | undefined = undefined;
  let count = 0;
  do {
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 30,
    });
    for (const b of blocks.results as any[]) {
      const data = b[b.type];
      const txt = data?.rich_text?.map((r: any) => r.plain_text).join("") ?? "";
      if (txt.trim()) lines.push(txt);
      count++;
      if (count >= 30) break;
    }
    cursor = blocks.next_cursor ?? undefined;
  } while (cursor && count < 30);
  return lines.join("\n\n");
}

async function applyClassification(
  notion: NotionClient,
  page: PageToClassify,
  result: ClassificationResult,
  pessoasIndex: EntityIndex,
  orgsIndex: EntityIndex,
  stats: ClassifierStats,
): Promise<void> {
  const props: Record<string, any> = {};

  if (page.db === "Reunioes") {
    if (!page.current_props.frente && result.frente) {
      props["Frente"] = { select: { name: result.frente } };
    }
    if (!page.current_props.tipo && result.tipo) {
      props["Tipo"] = { select: { name: result.tipo } };
    }
  } else {
    if (!page.current_props.categoria && result.categoria) {
      props["Categoria"] = { select: { name: result.categoria } };
    }
  }

  // Resolve pessoas + organizacoes → relation arrays
  const pessoasIds: string[] = [];
  for (const name of result.pessoas) {
    const id = await resolveOrCreate(notion, pessoasIndex, name, stats, "pessoas");
    if (id) pessoasIds.push(id);
  }
  const orgsIds: string[] = [];
  for (const name of result.organizacoes) {
    const id = await resolveOrCreate(notion, orgsIndex, name, stats, "orgs");
    if (id) orgsIds.push(id);
  }

  if (pessoasIds.length) {
    props["Pessoas"] = { relation: pessoasIds.map((id) => ({ id })) };
  }
  if (orgsIds.length) {
    props["Organizacoes"] = { relation: orgsIds.map((id) => ({ id })) };
  }

  if (Object.keys(props).length === 0) return;

  await notion.pages.update({ page_id: page.page_id, properties: props });
}

async function resolveOrCreate(
  notion: NotionClient,
  index: EntityIndex,
  name: string,
  stats: ClassifierStats,
  kind: "pessoas" | "orgs",
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2) return null;
  const norm = normalize(trimmed);

  // Exact normalized match
  const exact = index.byNormalizedName.get(norm);
  if (exact) {
    if (kind === "pessoas") stats.pessoas_linked++;
    else stats.orgs_linked++;
    return exact;
  }

  // Substring match (one direction or the other)
  for (const [existingNorm, id] of index.byNormalizedName) {
    if (existingNorm.length < 4 || norm.length < 4) continue;
    if (existingNorm.includes(norm) || norm.includes(existingNorm)) {
      if (kind === "pessoas") stats.pessoas_linked++;
      else stats.orgs_linked++;
      return id;
    }
  }

  // Create with Status=Pendente Revisão so Bruno can triage
  try {
    const resp = await notion.pages.create({
      parent: { database_id: index.dbId },
      properties: {
        // Title prop name varies; try Nome (Pessoas) and Nome (Organizacoes); fallback to whatever title exists
        Nome: { title: [{ text: { content: trimmed } }] } as any,
      } as any,
    });
    index.byNormalizedName.set(norm, resp.id);
    if (kind === "pessoas") stats.pessoas_created++;
    else stats.orgs_created++;
    // Try to set a 'Status' select if the schema allows; non-fatal if not.
    try {
      await notion.pages.update({
        page_id: resp.id,
        properties: { Status: { select: { name: "Pendente Revisão" } } } as any,
      });
    } catch {
      // ignore — schema may not have Status or option
    }
    return resp.id;
  } catch (err: any) {
    console.warn(`[classifier] could not create ${kind} "${trimmed}": ${err.message ?? err}`);
    return null;
  }
}
