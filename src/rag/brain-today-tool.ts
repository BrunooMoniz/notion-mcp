// src/rag/brain-today-tool.ts
// brain_today MCP tool — returns today's calendar events, per-event brain context,
// and top open tasks for the caller's account.
//
// Reuses (and does NOT duplicate) the pure functions from src/briefing/daily-briefing.ts:
//   getTodayEvents   — calendar events for a given date from brain_chunks
//   gatherContext    — per-event brain search context
//   getTopTasks      — open tasks from the Tasks Tracker data_source
//
// The briefing worker (runDailyBriefing) is unaffected: it still calls its own
// orchestration. This tool just exposes the same data pipeline as an MCP surface.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BriefingEvent, EventContext, BriefingTask } from "../briefing/daily-briefing.js";
import type pg from "pg";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";

// ---------- dep-injection seam -----------------------------------------------

type PoolLike = Pick<pg.Pool, "query">;

export interface BrainTodayDeps {
  getTodayEvents(pool: PoolLike, date: Date): Promise<BriefingEvent[]>;
  gatherContext(events: BriefingEvent[], tasks: BriefingTask[]): Promise<EventContext[]>;
  getTopTasks(limit?: number): Promise<BriefingTask[]>;
  getPool(): PoolLike;
}

/** Compute today's structured data. Pure over injected deps. */
export async function buildBrainToday(
  args: { date?: string },
  deps: BrainTodayDeps,
): Promise<BrainTodayResult> {
  // Resolve the target date: either the explicit date param or today (local).
  let now: Date;
  if (args.date) {
    // Parse YYYY-MM-DD as a local date (not UTC): treat it as midnight local.
    const [y, m, d] = args.date.split("-").map(Number);
    now = new Date(y, (m ?? 1) - 1, d ?? 1);
  } else {
    now = new Date();
  }

  // Local YYYY-MM-DD for the result.date field.
  const dateStr = localDateStr(now);

  const pool = deps.getPool();
  const events = await deps.getTodayEvents(pool, now);
  const tasks = await deps.getTopTasks(8);
  const context = await deps.gatherContext(events, tasks);

  return { date: dateStr, events, context, tasks };
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface BrainTodayResult {
  date: string;
  events: BriefingEvent[];
  context: EventContext[];
  tasks: BriefingTask[];
}

// ---------- MCP registration --------------------------------------------------

const DESCRIPTION = `Retorna os eventos do dia, contexto do cérebro para cada reunião, e as tarefas abertas prioritárias.

Parâmetros:
- date (opcional, YYYY-MM-DD): data alvo. Padrão: hoje (data local do servidor).

Retorna:
- date: a data consultada
- events: lista de eventos de calendário do dia (título, horário, calendário, participantes)
- context: para cada evento, itens relevantes do Zinom (reuniões/notas anteriores com os mesmos participantes)
- tasks: top ~8 tarefas abertas ordenadas por vencimento e prioridade

Use para: "o que tenho hoje?", "qual minha agenda?", "prepara o briefing do dia".`;

export function registerBrainTodayTool(server: McpServer): void {
  server.tool(
    "brain_today",
    DESCRIPTION,
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")
        .optional()
        .describe("Data alvo (YYYY-MM-DD). Padrão: hoje."),
    },
    async ({ date }) => {
      // getTopTasks calls notionFetch (owner's Tasks Tracker) — only meaningful
      // for the owner account. For friends, we gracefully skip it.
      const accountId = getAccountId() ?? DEFAULT_ACCOUNT_ID;
      const isOwner = accountId === DEFAULT_ACCOUNT_ID;

      const [
        { getTodayEvents, gatherContext, getTopTasks },
        { getPool },
      ] = await Promise.all([
        import("../briefing/daily-briefing.js"),
        import("./storage.js"),
      ]);

      const deps: BrainTodayDeps = {
        getTodayEvents,
        gatherContext,
        // Friends don't have the owner's Tasks Tracker; return empty list.
        getTopTasks: isOwner ? getTopTasks : async () => [],
        getPool,
      };

      const payload = await buildBrainToday({ date }, deps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
