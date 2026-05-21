// src/classifier/granola-to-reuniao.ts
// Auto-bridge from Granola notes to Notion Reuniões.
// For each new Granola note (since last sync):
//   - if a Reunião already exists with that Granola ID → skip (idempotent)
//   - else if title is recurring (Daily/1:1/Weekly) → consolidate into a
//     "lote" parent page (cap 10 instances per parent, then create next lote)
//   - else → create a fresh Reunião in the personal Reuniões DB
// Frente/Tipo are seeded heuristically; the brain-classifier refines later.

import { notionFetch } from "../clients.js";
import { getSyncState, setSyncState } from "../rag/storage.js";

const GRANOLA_BASE = "https://public-api.granola.ai/v1";
const REUNIOES_DS = "33a07ba5-bee8-811e-b576-000b0579facc"; // personal Reuniões data_source
const REUNIOES_DB = "33a07ba5-bee8-81ed-acfb-ffdadfab353f"; // personal Reuniões database container
const SECTION_CAP = 10;
const THROTTLE_MS = 220;

type Workspace = "personal" | "globalcripto" | "nora";
type RecurringKind = "daily" | "weekly" | "1:1" | null;

interface GranolaNote {
  id: string;
  title?: string | null;
  web_url?: string | null;
  owner?: { name?: string; email?: string };
  created_at?: string;
  updated_at?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  calendar_event?: { id?: string; title?: string } | null;
  summary_markdown?: string;
  summary_text?: string;
}

interface FeedConfig {
  workspace: Workspace;
  tokenEnv: string;
  syncKey: string;
}

const FEEDS: FeedConfig[] = [
  { workspace: "personal", tokenEnv: "GRANOLA_PERSONAL_TOKEN", syncKey: "granola-reuniao-personal" },
  { workspace: "globalcripto", tokenEnv: "GRANOLA_GLOBALCRIPTO_TOKEN", syncKey: "granola-reuniao-globalcripto" },
];

export interface GranolaToReuniaoStats {
  scanned: number;
  created: number;
  appended: number;
  skipped: number;
  errors: number;
  startedAt: Date;
  endedAt: Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function granolaGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`${GRANOLA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Granola HTTP ${resp.status}: ${text.slice(0, 200)}`);
    (e as any).status = resp.status;
    throw e;
  }
  return JSON.parse(text) as T;
}

// ---- title detection & normalization ----

function detectRecurring(title: string): RecurringKind {
  const t = title.trim();
  if (/^daily\b/i.test(t)) return "daily";
  if (/\b1:1\b|\b1 ?on ?1\b|^1:1\b/i.test(t)) return "1:1";
  if (/\bweekly\b|^weekly\b/i.test(t)) return "weekly";
  return null;
}

function normalizeParent(title: string): string {
  let s = title.trim();
  // strip ISO/BR dates
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  // strip trailing dashes
  s = s.replace(/[-—|:]+\s*$/g, " ");
  // collapse whitespace + dashes
  s = s.replace(/[-—|]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Title-case-ish — keep first cap
  return s;
}

function inferFrente(workspace: Workspace, note: GranolaNote): string {
  if (workspace === "globalcripto") return "Global Cripto";
  const t = (note.title ?? "").toLowerCase();
  const emails = (note.attendees ?? []).map((a) => (a.email ?? "").toLowerCase());
  const names = (note.attendees ?? []).map((a) => (a.name ?? "").toLowerCase()).join(" ");
  const haystack = `${t} ${names} ${emails.join(" ")}`;
  if (/\bnora\b|luigi|jean(?!\w)|victor|@noraprime/i.test(haystack)) return "Nora Finance";
  if (/\bglobal\s*cripto\b|\bgc\b|@globalcripto\.com/i.test(haystack)) return "Global Cripto";
  return "Pessoal";
}

function inferTipo(note: GranolaNote, recurring: RecurringKind): string {
  if (recurring === "daily" || recurring === "weekly") return "Time interno";
  if (recurring === "1:1") return "1:1";
  const att = (note.attendees ?? []).length;
  if (att === 2) return "1:1";
  return "Outro";
}

function buildSectionMarkdown(note: GranolaNote): string {
  const dateStr = note.created_at ? note.created_at.slice(0, 10) : "(sem data)";
  const summary = (note.summary_markdown ?? note.summary_text ?? "").trim();
  const attendees = (note.attendees ?? [])
    .map((a) => a.name || a.email)
    .filter(Boolean)
    .join(", ");
  const lines: string[] = [];
  lines.push("---");
  lines.push("");
  lines.push(`## ${dateStr} — ${note.title ?? "(sem título)"}`);
  if (note.web_url) lines.push(`[Granola](${note.web_url}) · \`${note.id}\``);
  else lines.push(`\`${note.id}\``);
  if (attendees) lines.push(`**Attendees:** ${attendees}`);
  lines.push("");
  if (summary) {
    lines.push(summary);
  } else {
    lines.push("_(sem summary)_");
  }
  lines.push("");
  return lines.join("\n");
}

function buildSingleBodyMarkdown(note: GranolaNote): string {
  const summary = (note.summary_markdown ?? note.summary_text ?? "").trim();
  const attendees = (note.attendees ?? []).map((a) => a.name || a.email).filter(Boolean).join(", ");
  const lines: string[] = [];
  if (note.web_url) lines.push(`[Granola](${note.web_url}) · \`${note.id}\``);
  if (attendees) lines.push(`**Attendees:** ${attendees}`);
  lines.push("");
  if (summary) lines.push(summary);
  else lines.push("_(sem summary)_");
  return lines.join("\n");
}

// ---- Notion helpers ----

interface ReuniaoMatch {
  id: string;
  title: string;
  granolaId: string;
}

async function findReuniaoByGranolaId(granolaId: string): Promise<ReuniaoMatch | null> {
  const resp = (await notionFetch("personal", `/v1/data_sources/${REUNIOES_DS}/query`, {
    method: "POST",
    body: {
      filter: {
        property: "Granola ID",
        rich_text: { contains: granolaId },
      },
      page_size: 1,
    },
  })) as { results: any[] };
  const r = resp.results[0];
  if (!r) return null;
  const title =
    r.properties?.Titulo?.title?.map((t: any) => t.plain_text ?? "").join("") || "";
  return { id: r.id, title, granolaId };
}

async function findReunioesByTitlePrefix(prefix: string): Promise<Array<{ id: string; title: string }>> {
  const resp = (await notionFetch("personal", `/v1/data_sources/${REUNIOES_DS}/query`, {
    method: "POST",
    body: {
      filter: {
        property: "Titulo",
        title: { contains: prefix },
      },
      page_size: 100,
    },
  })) as { results: any[] };
  return resp.results
    .map((r) => ({
      id: r.id,
      title: r.properties?.Titulo?.title?.map((t: any) => t.plain_text ?? "").join("") || "",
    }))
    .filter((x) => {
      const t = x.title.trim();
      // accept exact base OR "base (lote N)"
      return t === prefix || /^.+\s*\(lote\s+\d+\)\s*$/i.test(t) && t.startsWith(prefix);
    });
}

function loteNumberFromTitle(title: string, base: string): number {
  if (title.trim() === base.trim()) return 1;
  const m = title.match(/\(lote\s+(\d+)\)\s*$/i);
  return m ? parseInt(m[1], 10) : 1;
}

async function countH2Sections(pageId: string): Promise<number> {
  // Walk top-level blocks; count heading_2 occurrences (each section starts with "## ...").
  let cursor: string | undefined = undefined;
  let count = 0;
  do {
    const qs: any = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const resp = (await notionFetch("personal", `/v1/blocks/${pageId}/children`, {
      query: qs,
    })) as { results: any[]; next_cursor: string | null };
    for (const b of resp.results) {
      if (b.type === "heading_2") count += 1;
    }
    cursor = resp.next_cursor ?? undefined;
  } while (cursor);
  return count;
}

async function appendMarkdownToPage(pageId: string, markdown: string): Promise<void> {
  // We don't have a server-side markdown→blocks helper exposed; build minimal blocks.
  // The append uses the Notion blocks endpoint with paragraph/heading/divider mapping.
  const blocks: any[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "---") {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] },
      });
    } else if (line.trim() === "") {
      // skip empty lines (Notion auto-spaces)
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
      });
    }
    i += 1;
  }
  // Chunk by 100 to respect Notion limits
  for (let off = 0; off < blocks.length; off += 100) {
    const slice = blocks.slice(off, off + 100);
    await notionFetch("personal", `/v1/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: slice },
    });
  }
}

interface CreateReuniaoArgs {
  title: string;
  date: string; // YYYY-MM-DD
  granolaId: string;
  resumo: string;
  frente: string;
  tipo: string;
  bodyMarkdown?: string;
  recurringMarker?: boolean;
}

async function createReuniao(args: CreateReuniaoArgs): Promise<string> {
  const props: Record<string, any> = {
    Titulo: { title: [{ text: { content: args.title } }] },
    Data: { date: { start: args.date } },
    Tipo: { select: { name: args.tipo } },
    Frente: { select: { name: args.frente } },
    Resumo: { rich_text: [{ text: { content: args.resumo.slice(0, 1900) } }] },
  };
  if (args.granolaId) {
    props["Granola ID"] = { rich_text: [{ text: { content: args.granolaId } }] };
  }
  const resp = (await notionFetch("personal", "/v1/pages", {
    method: "POST",
    body: {
      // Notion API expects `database_id` parent for page creation under a DB.
      // `data_source_id` is for querying, not for page parent.
      parent: { type: "database_id", database_id: REUNIOES_DB },
      properties: props,
    },
  })) as { id: string };

  if (args.bodyMarkdown) {
    try {
      await appendMarkdownToPage(resp.id, args.bodyMarkdown);
    } catch (err: any) {
      console.warn(`[granola->reuniao] append body failed on ${resp.id}: ${err.message ?? err}`);
    }
  }
  return resp.id;
}

async function ensureRecurringParent(parentTitle: string, frente: string, tipo: string): Promise<string> {
  const candidates = await findReunioesByTitlePrefix(parentTitle);
  if (candidates.length === 0) {
    return await createReuniao({
      title: parentTitle,
      date: new Date().toISOString().slice(0, 10),
      granolaId: "",
      resumo: `[recorrente] Agregador de Granolas que matcham "${parentTitle}". Cap ${SECTION_CAP} por lote.`,
      frente,
      tipo,
      recurringMarker: true,
    });
  }
  // pick the highest-lote parent
  const sorted = candidates
    .map((c) => ({ ...c, lote: loteNumberFromTitle(c.title, parentTitle) }))
    .sort((a, b) => b.lote - a.lote);
  const top = sorted[0];
  const count = await countH2Sections(top.id);
  if (count < SECTION_CAP) return top.id;

  // create the next lote
  const nextLote = top.lote + 1;
  return await createReuniao({
    title: `${parentTitle} (lote ${nextLote})`,
    date: new Date().toISOString().slice(0, 10),
    granolaId: "",
    resumo: `[recorrente] Lote ${nextLote} do agregador "${parentTitle}".`,
    frente,
    tipo,
    recurringMarker: true,
  });
}

// ---- main ----

// Process-level mutex: prevents two ticks (e.g. initial + cron */15) from
// racing on parent creation and producing duplicate "(lote N)" pages.
let inFlight = false;

export async function syncGranolasToReunioes(): Promise<GranolaToReuniaoStats> {
  if (inFlight) {
    console.log("[granola->reuniao] tick skipped — another tick is in flight");
    return {
      scanned: 0,
      created: 0,
      appended: 0,
      skipped: 0,
      errors: 0,
      startedAt: new Date(),
      endedAt: new Date(),
    };
  }
  inFlight = true;
  try {
    return await syncGranolasToReunioesInner();
  } finally {
    inFlight = false;
  }
}

async function syncGranolasToReunioesInner(): Promise<GranolaToReuniaoStats> {
  const startedAt = new Date();
  const stats: GranolaToReuniaoStats = {
    scanned: 0,
    created: 0,
    appended: 0,
    skipped: 0,
    errors: 0,
    startedAt,
    endedAt: new Date(),
  };

  for (const feed of FEEDS) {
    const token = process.env[feed.tokenEnv];
    if (!token) continue;
    const lastSync = await getSyncState(feed.syncKey);
    const since = lastSync.toISOString();
    const feedStarted = new Date();

    let cursor: string | null | undefined = undefined;
    do {
      const qs = new URLSearchParams({ created_after: since });
      if (cursor) qs.set("cursor", cursor);
      let resp: { notes?: GranolaNote[]; hasMore?: boolean; cursor?: string | null };
      try {
        resp = await granolaGet(`/notes?${qs.toString()}`, token);
      } catch (err: any) {
        console.error(`[granola->reuniao] list failed (${feed.workspace}): ${err.message}`);
        stats.errors += 1;
        break;
      }
      const notes = resp.notes ?? [];
      for (const summary of notes) {
        stats.scanned += 1;
        try {
          // idempotency: check if a Reunião already exists with this Granola ID
          const existing = await findReuniaoByGranolaId(summary.id);
          if (existing) {
            stats.skipped += 1;
            continue;
          }

          // pull full content
          await sleep(THROTTLE_MS);
          const full = await granolaGet<GranolaNote>(
            `/notes/${summary.id}?include=transcript`,
            token,
          );

          const title = (full.title ?? summary.title ?? "(sem título)").trim();
          const recurring = detectRecurring(title);
          const frente = inferFrente(feed.workspace, full);
          const tipo = inferTipo(full, recurring);
          const date = (full.created_at ?? summary.created_at ?? new Date().toISOString()).slice(0, 10);
          const summaryText = (full.summary_markdown ?? full.summary_text ?? "").trim();
          const resumo = summaryText.slice(0, 400) || `Granola ${summary.id}`;

          if (recurring) {
            const parentTitle = normalizeParent(title);
            const parentId = await ensureRecurringParent(parentTitle, frente, tipo);
            await appendMarkdownToPage(parentId, buildSectionMarkdown(full));
            stats.appended += 1;
          } else {
            await createReuniao({
              title,
              date,
              granolaId: summary.id,
              resumo,
              frente,
              tipo,
              bodyMarkdown: buildSingleBodyMarkdown(full),
            });
            stats.created += 1;
          }
        } catch (err: any) {
          console.warn(`[granola->reuniao] note ${summary.id} failed: ${err.message ?? err}`);
          stats.errors += 1;
        }
      }
      cursor = resp.hasMore ? resp.cursor ?? null : null;
    } while (cursor);

    // Only advance the sync state if everything in this pass succeeded.
    // Otherwise we'd skip notes that failed and never retry them.
    if (stats.errors === 0) {
      await setSyncState(feed.syncKey, feedStarted);
    } else {
      console.warn(
        `[granola->reuniao] ${feed.workspace}: errors=${stats.errors} — sync_state NOT advanced; will retry next tick`,
      );
    }
    console.log(
      `[granola->reuniao] ${feed.workspace}: scanned=${stats.scanned} created=${stats.created} appended=${stats.appended} skipped=${stats.skipped} errors=${stats.errors}`,
    );
  }

  stats.endedAt = new Date();
  return stats;
}
