// src/classifier/revisitar.ts
// Spaced repetition: pick Insights created N days ago and create
// "Revisitar" entries so Bruno can revisit them.

import { Client as NotionClient } from "@notionhq/client";

const PARENT_PAGE_ID = "33707ba5-bee8-810d-bc21-c6d1514502b8"; // Cérebro
const INSIGHTS_DB = "33a07ba5-bee8-81a4-b929-c8bc631ccba5";

const WINDOWS_DAYS = [1, 3, 7, 21, 60];

interface RevisitarStats {
  candidates: number;
  created: number;
  startedAt: Date;
  endedAt: Date;
}

let cachedRevisitarDbId: string | null = null;

export async function ensureRevisitarDb(notion: NotionClient): Promise<string> {
  if (cachedRevisitarDbId) return cachedRevisitarDbId;

  // Search for existing DB with title "Revisitar" under Cérebro
  const search = await notion.search({
    query: "Revisitar",
    filter: { property: "object", value: "database" },
  });
  for (const r of search.results as any[]) {
    const title = r.title?.map((t: any) => t.plain_text).join("") ?? "";
    if (title.trim() === "Revisitar") {
      cachedRevisitarDbId = r.id;
      return r.id;
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
  cachedRevisitarDbId = (created as any).id;
  console.log(`[revisitar] created DB ${cachedRevisitarDbId}`);
  return cachedRevisitarDbId!;
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
  const notion = new NotionClient({ auth: token });

  const dbId = await ensureRevisitarDb(notion);

  // Build today's set of revisitar entries already present, so we don't duplicate
  const todayIso = new Date().toISOString().slice(0, 10);
  const existing = await notion.databases.query({
    database_id: dbId,
    filter: { property: "Data", date: { equals: todayIso } } as any,
    page_size: 50,
  });
  const existingInsightIds = new Set<string>();
  for (const e of existing.results as any[]) {
    const rel = e.properties?.Insight?.relation ?? [];
    for (const r of rel) existingInsightIds.add(r.id);
  }

  for (const days of WINDOWS_DAYS) {
    const candidate = await pickCandidate(notion, days, existingInsightIds);
    if (!candidate) continue;
    stats.candidates++;
    try {
      await notion.pages.create({
        parent: { database_id: dbId },
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
  notion: NotionClient,
  daysAgo: number,
  exclude: Set<string>,
): Promise<InsightCandidate | null> {
  const target = new Date();
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() - daysAgo);
  const dayStart = target.toISOString();
  const dayEnd = new Date(target.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const resp = await notion.databases.query({
    database_id: INSIGHTS_DB,
    filter: {
      and: [
        { timestamp: "created_time", created_time: { on_or_after: dayStart } },
        { timestamp: "created_time", created_time: { before: dayEnd } },
      ],
    } as any,
    page_size: 20,
  });

  const candidates: InsightCandidate[] = [];
  for (const page of resp.results as any[]) {
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
