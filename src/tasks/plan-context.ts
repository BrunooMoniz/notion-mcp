// src/tasks/plan-context.ts
// 003-tasks-v1 — PURE planning helpers behind the zinom_plan_context tool:
// timezone math via Intl (zero new dependencies), free-slot computation per
// day (work window minus TIMED events; all-day events never block), event
// dedup by (normalized title + start) and open-task grouping by status.
// No network, no storage — 100% unit-testable. The tool wires the data in.
import { normalize, STATUS_ORDER, type Task, type CanonicalStatus } from "./model.js";

export const PLAN_MAX_DAYS = 35;
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";
export const DEFAULT_WORK_START = "09:00";
export const DEFAULT_WORK_END = "19:00";

export interface PlanEvent {
  title: string;
  start: string; // ISO datetime, or YYYY-MM-DD when all_day
  end: string | null;
  all_day: boolean;
  calendar: string;
}

export interface FreeSlot {
  start: string; // local "HH:MM" in the requested timezone
  end: string;
  min: number;
}

export interface DayFreeSlots {
  date: string; // YYYY-MM-DD
  free: FreeSlot[];
  free_min: number;
}

// --- timezone math (Intl only) ---------------------------------------------------

/** True when the IANA timezone is valid (Intl throws on unknown zones). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (minutes to ADD to UTC to get local wall time) of `tz` at `utc`. */
function tzOffsetMinutes(tz: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utc)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUTC - utc.getTime()) / 60_000);
}

/** The UTC instant of local wall time `YYYY-MM-DD` + `HH:MM` in `tz`. Two-pass
 *  offset resolution handles DST edges well enough for planning granularity. */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  let offset = tzOffsetMinutes(tz, naive);
  const first = new Date(naive.getTime() - offset * 60_000);
  offset = tzOffsetMinutes(tz, first);
  return new Date(naive.getTime() - offset * 60_000);
}

/** Local "HH:MM" of a UTC instant in `tz`. */
function localHHMM(utc: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utc)) parts[p.type] = p.value;
  return `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
}

// --- date iteration ----------------------------------------------------------------

/** Inclusive list of YYYY-MM-DD dates from start to end (calendar dates). */
export function listDates(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  for (let t = s; t <= e; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Weekday (0=Sun..6=Sat) of a calendar date string. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// --- free slots ----------------------------------------------------------------------

export interface FreeSlotsOptions {
  period_start: string; // YYYY-MM-DD
  period_end: string;
  timezone: string;
  work_start: string; // "HH:MM"
  work_end: string;
  include_weekends: boolean;
}

const DEFAULT_EVENT_MIN = 60; // timed events without an end block 1h

/** PURE: per-day free windows = the work window minus TIMED events (all-day
 *  events do NOT block). Overlapping/contained events are merged. Slot times
 *  are local wall times of the requested timezone. */
export function computeFreeSlots(events: PlanEvent[], opts: FreeSlotsOptions): DayFreeSlots[] {
  // Pre-resolve busy intervals (UTC ms) once.
  const busy: Array<{ start: number; end: number }> = [];
  for (const ev of events) {
    if (ev.all_day) continue;
    if (!ev.start || !/T/.test(ev.start)) continue;
    const s = new Date(ev.start).getTime();
    if (Number.isNaN(s)) continue;
    let e = ev.end ? new Date(ev.end).getTime() : NaN;
    if (Number.isNaN(e) || e <= s) e = s + DEFAULT_EVENT_MIN * 60_000;
    busy.push({ start: s, end: e });
  }
  busy.sort((a, b) => a.start - b.start);

  const days: DayFreeSlots[] = [];
  for (const date of listDates(opts.period_start, opts.period_end)) {
    const wd = weekdayOf(date);
    if (!opts.include_weekends && (wd === 0 || wd === 6)) continue;

    const winStart = zonedTimeToUtc(date, opts.work_start, opts.timezone).getTime();
    const winEnd = zonedTimeToUtc(date, opts.work_end, opts.timezone).getTime();
    if (winEnd <= winStart) {
      days.push({ date, free: [], free_min: 0 });
      continue;
    }

    // Merge the busy intervals clamped to this window.
    const merged: Array<{ start: number; end: number }> = [];
    for (const b of busy) {
      const s = Math.max(b.start, winStart);
      const e = Math.min(b.end, winEnd);
      if (e <= s) continue;
      const last = merged[merged.length - 1];
      if (last && s <= last.end) last.end = Math.max(last.end, e);
      else merged.push({ start: s, end: e });
    }

    const free: FreeSlot[] = [];
    let cursor = winStart;
    for (const b of merged) {
      if (b.start > cursor) free.push(slot(cursor, b.start, opts.timezone));
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < winEnd) free.push(slot(cursor, winEnd, opts.timezone));

    days.push({ date, free, free_min: free.reduce((acc, f) => acc + f.min, 0) });
  }
  return days;
}

function slot(startMs: number, endMs: number, tz: string): FreeSlot {
  return {
    start: localHHMM(new Date(startMs), tz),
    end: localHHMM(new Date(endMs), tz),
    min: Math.round((endMs - startMs) / 60_000),
  };
}

// --- event dedup -----------------------------------------------------------------------

/** PURE: drop duplicate events by (normalized title + start) — the same meeting
 *  often appears on several calendars/accounts. First occurrence wins. */
export function dedupPlanEvents(events: PlanEvent[]): PlanEvent[] {
  const seen = new Set<string>();
  return events.filter((ev) => {
    const key = `${normalize(ev.title)}|${ev.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- open-task grouping -------------------------------------------------------------------

export interface PlanTaskEntry {
  id: string;
  title: string;
  prioridade: string | null;
  prazo: string | null;
  tempo_estimado_min: number | null;
  overdue: boolean;
}

export interface PlanTasksSection {
  /** Group order: backlog, todo, in_progress, blocked, then literal statuses. */
  by_status: Record<string, PlanTaskEntry[]>;
  /** Overdue tasks highlighted separately (also present in their group). */
  overdue: PlanTaskEntry[];
}

const OPEN_ORDER: CanonicalStatus[] = STATUS_ORDER.filter(
  (s) => s !== "done" && s !== "canceled",
);

/** PURE: group OPEN canonical tasks by status in the fixed plan order. Tasks
 *  with passthrough (literal) statuses get their own groups after the
 *  canonical ones. `todayISO` decides overdue. */
export function groupOpenTasks(tasks: Task[], todayISO: string): PlanTasksSection {
  const by_status: Record<string, PlanTaskEntry[]> = {};
  for (const s of OPEN_ORDER) by_status[s] = [];
  const overdue: PlanTaskEntry[] = [];

  for (const t of tasks) {
    const status = String(t.status || "(sem status)");
    const entry: PlanTaskEntry = {
      id: t.id,
      title: t.title,
      prioridade: t.prioridade ? String(t.prioridade) : null,
      prazo: t.prazo ?? null,
      tempo_estimado_min: typeof t.tempo_estimado_min === "number" ? t.tempo_estimado_min : null,
      overdue: !!(t.prazo && String(t.prazo).slice(0, 10) < todayISO),
    };
    if (!by_status[status]) by_status[status] = [];
    by_status[status].push(entry);
    if (entry.overdue) overdue.push(entry);
  }

  // Drop empty canonical groups for a compact payload.
  for (const s of OPEN_ORDER) {
    if (by_status[s].length === 0) delete by_status[s];
  }
  return { by_status, overdue };
}

// --- window validation + guidance -----------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE: validate the requested window; returns an error string or null. */
export function validatePlanWindow(start: string, end: string): string | null {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return "period_start e period_end devem ser datas YYYY-MM-DD";
  }
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "datas inválidas";
  if (e < s) return "period_end deve ser igual ou posterior a period_start";
  const days = Math.round((e - s) / 86_400_000) + 1;
  if (days > PLAN_MAX_DAYS) return `janela máxima de ${PLAN_MAX_DAYS} dias (pediu ${days})`;
  return null;
}

/** The 3 fixed guidance lines the tool always returns (spec). */
export const PLAN_GUIDANCE: string[] = [
  "Aloque as tarefas dentro dos free_slots respeitando prazo e prioridade (overdue e urgente primeiro) e o tempo_estimado_min de cada uma.",
  "Proponha blocktimes: crie eventos com create_calendar_event na agenda Google; sem Google conectado, use zinom_create_task com data + fim para reservar o bloco.",
  "Depois de planejar, atualize o board com zinom_update_task (in_progress ao começar, done ao concluir; registre cobranças via nota_append).",
];
