// src/briefing/daily-briefing.ts
// Server-side daily briefing worker.
//
// Each morning it generates a PT-BR briefing — today's agenda + per-meeting
// prep (relevant history from the brain) + top open/overdue tasks — and writes
// it to a Notion "Hoje" page (BRIEFING_PAGE_ID). Runs on a cron in the
// brain-classifier process (see index-classifier.ts).
//
// Reuses (does NOT reinvent):
//   - getPool / recordRun        (rag/storage)   — DB pool + observability
//   - brainSearch                (rag/search)    — per-meeting/topic context
//   - callHaiku                  (classifier/anthropic) — PT-BR synthesis
//   - getClient / notionFetch    (clients)       — Notion SDK + raw REST
//   - markdownToBlocks           (markdown)      — markdown -> Notion blocks

import type pg from "pg";
import { getPool, recordRun } from "../rag/storage.js";
import { brainSearch } from "../rag/search.js";
import { callHaiku } from "../classifier/anthropic.js";
import { markdownToBlocks } from "../markdown.js";

// NOTE: ../clients.js is imported LAZILY inside getTopTasks / writeBriefingPage.
// That module validates required Notion tokens at import time and calls
// process.exit(1) when they're absent — importing it eagerly would kill the
// test process (no creds). The pure surface (getTodayEvents / prompt assembly)
// must stay importable without credentials, so the import is deferred to the
// two functions that actually talk to Notion.

// Tasks Tracker data_source (workspace 'personal'). Under Notion API
// 2025-09-03 queries hit /v1/data_sources/{id}/query.
const TASKS_DATA_SOURCE = "30d07ba5-bee8-8040-841b-000b5d0b5d84";

// Minimal pg-like surface so tests can inject a fake pool (no live DB).
type PoolLike = Pick<pg.Pool, "query">;

// Pluggable synth so tests can echo without hitting Anthropic.
type SynthFn = (system: string, user: string) => Promise<string>;

export interface BriefingEvent {
  title: string;
  time: string; // HH:MM local, or "" for all-day / unknown
  calendar: string;
  attendees: string[];
}

export interface ContextItem {
  title: string;
  url: string;
  snippet: string;
}

export interface EventContext {
  eventTitle: string;
  items: ContextItem[];
}

export interface BriefingTask {
  name: string;
  priority: string;
  due: string | null; // YYYY-MM-DD or null
  tempo_estimado: number | null; // minutes
}

// --- today's calendar events ------------------------------------------------

interface EventRow {
  source_id: string;
  title: string;
  data: string | null; // YYYY-MM-DD or ISO
  calendar_label: string | null;
  attendees: unknown;
}

/** Local YYYY-MM-DD for a Date (so "today" matches the user's calendar day). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** HH:MM (local) from an ISO timestamp; "" for an all-day date or no time. */
function timeOf(data: string | null): string {
  if (!data) return "";
  // All-day events are stored as a bare YYYY-MM-DD (no time component).
  if (!/T/.test(data)) return "";
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Today's calendar events from brain_chunks. Filters source_type='calendar'
 * AND (metadata->>'data')::date = the current (local) date, dedupes by
 * source_id, and returns a compact list. The event title is the first `# `
 * line of the chunk text (the iCal indexer writes `# <summary>` as line 1).
 */
export async function getTodayEvents(
  pool: PoolLike,
  now: Date,
): Promise<BriefingEvent[]> {
  const today = localDateStr(now);
  const sql = `
    SELECT source_id,
           text,
           metadata->>'data'            AS data,
           metadata->>'calendar_label'  AS calendar_label,
           metadata->'attendees'        AS attendees
    FROM brain_chunks
    WHERE source_type = 'calendar'
      AND (metadata->>'data')::date = $1::date
    ORDER BY metadata->>'data' ASC
  `;
  const { rows } = await pool.query(sql, [today]);

  const seen = new Set<string>();
  const events: BriefingEvent[] = [];
  for (const r of rows as (EventRow & { text?: string })[]) {
    if (seen.has(r.source_id)) continue;
    seen.add(r.source_id);

    const title = r.title ?? titleFromText(r.text);
    const attendees = Array.isArray(r.attendees)
      ? (r.attendees as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    events.push({
      title: title || "(sem título)",
      time: timeOf(r.data),
      calendar: r.calendar_label ?? "",
      attendees,
    });
  }
  return events;
}

/** Pull the event title from the chunk text's first `# ` heading line. */
function titleFromText(text: string | undefined): string {
  if (!text) return "";
  const first = text.split("\n")[0] ?? "";
  return first.replace(/^#\s+/, "").trim();
}

// --- per-event context from the brain --------------------------------------

/**
 * For each event, derive a query (title + attendees) and pull the most
 * relevant prior brain items (reuniões/decisões/insights), EXCLUDING calendar
 * chunks (we want history, not the agenda echoing itself). Compact: title +
 * url + a short snippet. `tasks` is accepted for signature symmetry but not
 * used to drive context queries (events drive the per-meeting prep).
 */
export async function gatherContext(
  events: BriefingEvent[],
  _tasks: BriefingTask[],
): Promise<EventContext[]> {
  const out: EventContext[] = [];
  for (const ev of events) {
    const query = [ev.title, ...ev.attendees].filter(Boolean).join(" ");
    let items: ContextItem[] = [];
    try {
      const hits = await brainSearch(query, {
        topK: 5,
        filters: { exclude_source_type: "calendar" },
      });
      items = hits.map((h) => ({
        title: titleFromText(h.chunk.text) || h.chunk.db_name || "(item)",
        url: h.chunk.parent_url ?? "",
        snippet: snippetOf(h.chunk.text),
      }));
    } catch (err) {
      console.warn(
        `[briefing] context search failed for "${ev.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    out.push({ eventTitle: ev.title, items });
  }
  return out;
}

/** A short, single-line snippet from a chunk's body (skips the title line). */
function snippetOf(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const body = lines.slice(1).filter((l) => l && !/^#/.test(l) && !/^\*\*/.test(l));
  const s = (body[0] ?? lines[0] ?? "").replace(/\s+/g, " ").trim();
  return s.slice(0, 200);
}

// --- top open / overdue tasks -----------------------------------------------

const PRIORITY_RANK: Record<string, number> = { Ultra: 0, High: 1, Medium: 2, Low: 3 };

/**
 * Top open tasks from the Tasks Tracker data_source (workspace 'personal'):
 * Status NOT in {Done, Canceled}, sorted by Due asc (no-due last) then
 * Priority (Ultra > High > Medium > Low). Returns the top ~8, compact.
 */
export async function getTopTasks(limit = 8): Promise<BriefingTask[]> {
  const { getClient, notionFetch } = await import("../clients.js");
  // Touch getClient so the workspace scope assertion runs (no-op out of an
  // HTTP request), keeping behaviour consistent with the rest of the codebase.
  getClient("personal");

  const resp = (await notionFetch(
    "personal",
    `/v1/data_sources/${TASKS_DATA_SOURCE}/query`,
    {
      method: "POST",
      body: {
        filter: {
          and: [
            { property: "Status", status: { does_not_equal: "Done" } },
            { property: "Status", status: { does_not_equal: "Canceled" } },
          ],
        },
        sorts: [{ property: "Due date", direction: "ascending" }],
        page_size: 50,
      },
    },
  )) as { results: any[] };

  const tasks: BriefingTask[] = (resp.results ?? []).map((page) => {
    const props = page.properties ?? {};
    const titleProp = Object.values<any>(props).find((p) => p?.type === "title");
    const name =
      titleProp?.title?.map((t: any) => t.plain_text).join("").trim() || "(sem título)";
    const priority = props["Priority"]?.select?.name ?? "";
    const due = props["Due date"]?.date?.start ?? null;
    const tempo =
      typeof props["Tempo estimado"]?.number === "number"
        ? props["Tempo estimado"].number
        : null;
    return { name, priority, due: due ? String(due).slice(0, 10) : null, tempo_estimado: tempo };
  });

  tasks.sort((a, b) => {
    // Due asc, tasks with no due date last.
    const da = a.due ?? "9999-99-99";
    const db = b.due ?? "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    return pa - pb;
  });

  return tasks.slice(0, limit);
}

// --- prompt + markdown assembly ---------------------------------------------

const BRIEFING_SYSTEM = `Você é o assistente do "segundo cérebro" do Bruno Moniz e escreve o briefing matinal dele.

Bruno é co-founder da Global Cripto (exchange/PSAV cripto no Brasil) e da Nora Finance (stablecoin BRS).

Escreva SEMPRE em português do Brasil (PT-BR), em MARKDOWN, conciso e escaneável — esta página é uma leitura rápida da manhã, NÃO um ensaio. Sem preâmbulo, sem despedida.

Estrutura obrigatória (use exatamente estes títulos de seção):
## Agenda de hoje
- Para cada evento: horário + título (+ calendário). Embaixo, 1-2 linhas de prep usando o contexto fornecido ("o que já rolou com X / pontos quentes / o que ficou em aberto"). Se não houver contexto relevante para um evento, diga em uma linha curta. Se não houver eventos, escreva "Sem compromissos hoje."
## Foco do dia
- Liste as tarefas a priorizar hoje (as mais urgentes/importantes da lista fornecida). Curto, em bullets.
## Loops abertos
- Tarefas atrasadas (due no passado) ou pendentes que estão pingando. Curto, em bullets.

Use APENAS as informações fornecidas. Não invente eventos, pessoas, tarefas ou fatos.`;

function fmtTempo(min: number | null): string {
  if (min == null) return "";
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const r = min % 60;
    return r ? ` (~${h}h${r}m)` : ` (~${h}h)`;
  }
  return ` (~${min}m)`;
}

/**
 * Assemble the user prompt fed to the synth. Pure + deterministic so tests can
 * assert it carries the events / contexts / tasks and names the sections.
 */
export function buildBriefingPrompt(
  events: BriefingEvent[],
  contexts: EventContext[],
  tasks: BriefingTask[],
  now: Date,
): string {
  const todayStr = localDateStr(now);
  const ctxByEvent = new Map(contexts.map((c) => [c.eventTitle, c.items]));
  const lines: string[] = [];

  lines.push(`Data de hoje: ${todayStr}.`);
  lines.push("");
  lines.push("Gere o briefing matinal a partir dos dados abaixo. Siga a estrutura de seções pedida.");
  lines.push("");

  lines.push("### EVENTOS DE HOJE");
  if (events.length === 0) {
    lines.push("(nenhum evento na agenda hoje)");
  } else {
    for (const ev of events) {
      const when = ev.time ? ev.time : "dia todo";
      const who = ev.attendees.length ? ` — com ${ev.attendees.join(", ")}` : "";
      const cal = ev.calendar ? ` [${ev.calendar}]` : "";
      lines.push(`- ${when} — ${ev.title}${cal}${who}`);
      const items = ctxByEvent.get(ev.title) ?? [];
      if (items.length === 0) {
        lines.push("  contexto: (sem histórico relevante)");
      } else {
        for (const it of items) {
          const link = it.url ? ` (${it.url})` : "";
          lines.push(`  contexto: ${it.title}${link} — ${it.snippet}`);
        }
      }
    }
  }
  lines.push("");

  lines.push("### TAREFAS ABERTAS (ordenadas por vencimento, depois prioridade)");
  if (tasks.length === 0) {
    lines.push("(nenhuma tarefa aberta)");
  } else {
    for (const t of tasks) {
      const due = t.due ? `vence ${t.due}` : "sem data";
      const overdue = t.due && t.due < todayStr ? " [ATRASADA]" : "";
      const prio = t.priority ? `prioridade ${t.priority}` : "sem prioridade";
      lines.push(`- ${t.name} — ${prio}, ${due}${overdue}${fmtTempo(t.tempo_estimado)}`);
    }
  }

  lines.push("");
  lines.push(
    "Produza o briefing com EXATAMENTE estas seções, nesta ordem: " +
      "## Agenda de hoje, ## Foco do dia, ## Loops abertos. " +
      "Mesmo sem eventos, ainda produza as seções Foco do dia e Loops abertos a partir das tarefas.",
  );

  return lines.join("\n");
}

/**
 * Build the final PT-BR briefing markdown. `synth` defaults to callHaiku and
 * is injectable so tests need no Anthropic call.
 */
export async function buildBriefingMarkdown(
  events: BriefingEvent[],
  contexts: EventContext[],
  tasks: BriefingTask[],
  now: Date,
  synth: SynthFn = callHaiku,
): Promise<string> {
  const user = buildBriefingPrompt(events, contexts, tasks, now);
  const md = await synth(BRIEFING_SYSTEM, user);
  return md.trim();
}

// --- write to the "Hoje" page -----------------------------------------------

/**
 * Write the briefing to the page in BRIEFING_PAGE_ID: clear the page's existing
 * top-level blocks, then append the new blocks. SAFE: only ever touches the
 * explicit BRIEFING_PAGE_ID. If unset, logs a clear warning and returns without
 * writing (never guesses a page).
 */
export async function writeBriefingPage(markdown: string): Promise<void> {
  const pageId = process.env.BRIEFING_PAGE_ID;
  if (!pageId) {
    console.warn(
      "[briefing] BRIEFING_PAGE_ID not set — skipping write (refusing to guess a page).",
    );
    return;
  }

  const { getClient } = await import("../clients.js");
  const notion = getClient("personal");

  // 1) Clear existing top-level blocks on the page.
  const children = (await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  })) as { results: { id: string }[] };
  for (const block of children.results) {
    try {
      await notion.blocks.delete({ block_id: block.id });
    } catch (err) {
      console.warn(
        `[briefing] failed to delete block ${block.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 2) Append the new briefing blocks (Notion caps appends at 100 children).
  const blocks = markdownToBlocks(markdown);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + 100) as Parameters<
        typeof notion.blocks.children.append
      >[0]["children"],
    });
  }
}

// --- orchestration ----------------------------------------------------------

/**
 * Orchestrate the full daily briefing: gather today's events + their context +
 * top tasks, synthesize the markdown, write it to the Hoje page, and record a
 * telemetry run. Never throws (wrapped) — telemetry captures failures.
 */
export async function runDailyBriefing(): Promise<void> {
  const startedAt = new Date();
  const now = startedAt;
  let events: BriefingEvent[] = [];
  let tasks: BriefingTask[] = [];
  try {
    const pool = getPool();
    events = await getTodayEvents(pool, now);
    tasks = await getTopTasks();
    const contexts = await gatherContext(events, tasks);
    const markdown = await buildBriefingMarkdown(events, contexts, tasks, now);
    await writeBriefingPage(markdown);

    await recordRun({
      worker: "briefing",
      source: "daily",
      ok: true,
      counts: { events: events.length, tasks: tasks.length },
      startedAt,
      endedAt: new Date(),
    });
  } catch (err) {
    await recordRun({
      worker: "briefing",
      source: "daily",
      ok: false,
      counts: { events: events.length, tasks: tasks.length },
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      endedAt: new Date(),
    });
    throw err;
  }
}
