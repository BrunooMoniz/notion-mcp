// src/classifier/revisitar.ts
// Spaced repetition: pick Insights created N days ago and create
// "Revisitar" entries so Bruno can revisit them.

import { Client as NotionClient } from "@notionhq/client";
import { NOTION_API_VERSION, notionFetch } from "../clients.js";

const PARENT_PAGE_ID = "33707ba5-bee8-810d-bc21-c6d1514502b8"; // Cérebro
const INSIGHTS_DB = "33a07ba5-bee8-81a4-b929-c8bc631ccba5";
// Under Notion API 2025-09-03 queries hit /v1/data_sources/{id}/query.
const INSIGHTS_DATA_SOURCE = "33a07ba5-bee8-81fc-8f49-000b348bf422";
const REVISITAR_DB = "35707ba5-bee8-81bf-9905-c8a68c75b2a7";
const REVISITAR_DATA_SOURCE = "35707ba5-bee8-81be-a6af-000bf9c36f08";

const WINDOWS_DAYS = [1, 3, 7, 21, 60];

interface RevisitarStats {
  candidates: number;
  created: number;
  startedAt: Date;
  endedAt: Date;
}

interface RevisitarRefs {
  databaseId: string;
  dataSourceId: string;
}

let cachedRevisitarRefs: RevisitarRefs | null = {
  databaseId: REVISITAR_DB,
  dataSourceId: REVISITAR_DATA_SOURCE,
};

export async function ensureRevisitarDb(notion: NotionClient): Promise<RevisitarRefs> {
  if (cachedRevisitarRefs) return cachedRevisitarRefs;

  // Search for existing data_source titled "Revisitar"
  const search = await notion.search({
    query: "Revisitar",
    filter: { property: "object", value: "data_source" as any },
  });
  for (const r of search.results as any[]) {
    if (r.object !== "data_source") continue;
    const title = r.title?.map((t: any) => t.plain_text).join("") ?? "";
    if (title.trim() === "Revisitar") {
      const databaseId = r.parent?.database_id ?? r.id;
      cachedRevisitarRefs = { databaseId, dataSourceId: r.id };
      return cachedRevisitarRefs;
    }
  }

  // Not found → create
  const created = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: "Revisitar" } }],
    properties: {
      Item: { title: {} },
      Insight: { relation: { database_id: INSIGHTS_DB, single_property: {} } } as any,
      Data: { date: {} },
      Janela: {
        select: {
          options: [
            { name: "1d", color: "blue" },
            { name: "3d", color: "green" },
            { name: "7d", color: "yellow" },
            { name: "21d", color: "orange" },
            { name: "60d", color: "red" },
          ],
        },
      },
      Status: {
        select: {
          options: [
            { name: "Aberto", color: "default" },
            { name: "Revisado", color: "green" },
            { name: "Skipped", color: "gray" },
          ],
        },
      },
    },
  });
  const databaseId = (created as any).id;
  const dataSourceId = (created as any).data_sources?.[0]?.id ?? databaseId;
  cachedRevisitarRefs = { databaseId, dataSourceId };
  console.log(`[revisitar] created DB ${databaseId} (data_source ${dataSourceId})`);
  return cachedRevisitarRefs;
}

interface InsightCandidate {
  page_id: string;
  title: string;
  url: string;
  daysAgo: number;
}

export async function runRevisitar(): Promise<RevisitarStats> {
  const stats: RevisitarStats = {
    candidates: 0,
    created: 0,
    startedAt: new Date(),
    endedAt: new Date(),
  };

  const token = process.env.NOTION_PERSONAL_TOKEN;
  if (!token) throw new Error("NOTION_PERSONAL_TOKEN not set");
  const notion = new NotionClient({ auth: token, notionVersion: NOTION_API_VERSION });

  const refs = await ensureRevisitarDb(notion);

  // Build today's set of revisitar entries already present, so we don't duplicate
  const todayIso = new Date().toISOString().slice(0, 10);
  const existing = (await notionFetch("personal", `/v1/data_sources/${refs.dataSourceId}/query`, {
    method: "POST",
    body: {
      filter: { property: "Data", date: { equals: todayIso } },
      page_size: 50,
    },
  })) as { results: any[] };
  const existingInsightIds = new Set<string>();
  for (const e of existing.results) {
    const rel = e.properties?.Insight?.relation ?? [];
    for (const r of rel) existingInsightIds.add(r.id);
  }

  for (const days of WINDOWS_DAYS) {
    const candidate = await pickCandidate(days, existingInsightIds);
    if (!candidate) continue;
    stats.candidates++;
    try {
      await notion.pages.create({
        parent: { database_id: refs.databaseId },
        properties: {
          Item: { title: [{ text: { content: candidate.title } }] },
          Insight: { relation: [{ id: candidate.page_id }] },
          Data: { date: { start: todayIso } },
          Janela: { select: { name: `${days}d` } },
          Status: { select: { name: "Aberto" } },
        } as any,
      });
      stats.created++;
      existingInsightIds.add(candidate.page_id);
    } catch (err: any) {
      console.warn(`[revisitar] failed to create entry for ${candidate.page_id}: ${err.message ?? err}`);
    }
  }

  stats.endedAt = new Date();
  return stats;
}

async function pickCandidate(
  daysAgo: number,
  exclude: Set<string>,
): Promise<InsightCandidate | null> {
  const target = new Date();
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() - daysAgo);
  const dayStart = target.toISOString();
  const dayEnd = new Date(target.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const resp = (await notionFetch("personal", `/v1/data_sources/${INSIGHTS_DATA_SOURCE}/query`, {
    method: "POST",
    body: {
      filter: {
        and: [
          { timestamp: "created_time", created_time: { on_or_after: dayStart } },
          { timestamp: "created_time", created_time: { before: dayEnd } },
        ],
      },
      page_size: 20,
    },
  })) as { results: any[] };

  const candidates: InsightCandidate[] = [];
  for (const page of resp.results) {
    if (exclude.has(page.id)) continue;
    const titleProp = Object.values<any>(page.properties).find((p) => p.type === "title");
    const title = titleProp?.title?.map((t: any) => t.plain_text).join("") ?? "(sem título)";
    candidates.push({
      page_id: page.id,
      title: title.slice(0, 200),
      url: page.url,
      daysAgo,
    });
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
