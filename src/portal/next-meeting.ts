// src/portal/next-meeting.ts
// 002-app-v2 — "Próxima reunião" card: the account's next FUTURE calendar
// event, read from the already-indexed source_type="calendar" chunks (no live
// calendar call). The event start lives in metadata.data, but its shape varies
// by source: the iCal pass stores a full ISO timestamp for timed events and
// YYYY-MM-DD for all-day ones (calendar-ics-source.ts); the Google-OAuth pass
// stores YYYY-MM-DD only, with the precise time inside the chunk text's
// "**Quando:** ..." line (gcal-oauth-source.ts). parseEventStart handles all
// three robustly. Account scope ALWAYS comes from the caller (session).
import { getPool, titleFromHeaderLine } from "../rag/storage.js";

export interface NextMeeting {
  found: boolean;
  title?: string;
  starts_at?: string; // ISO-8601 (or YYYY-MM-DD for all-day events)
  calendar?: string | null;
  attendees?: string[];
}

/** Candidate row shape (exported for the pure picker's unit tests). */
export interface CalendarEventRow {
  first_line: string | null;
  text: string;
  db_name: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Resolve the event start as a Date from a candidate row, or null when no
 * parseable date exists. Preference order:
 *   1. metadata.data when it carries a time component (iCal timed events);
 *   2. a "**Quando:** <ISO>" line in the chunk text when it parses with a time
 *      (gcal-oauth timed events store date-only metadata);
 *   3. metadata.data as a date-only value (all-day events → local midnight).
 * Exported pure for unit tests.
 */
export function parseEventStart(row: CalendarEventRow): Date | null {
  const meta = row.metadata ?? {};
  const data = typeof meta.data === "string" ? meta.data.trim() : "";

  // 1. Full ISO timestamp in metadata (iCal timed events).
  if (/^\d{4}-\d{2}-\d{2}T/.test(data)) {
    const d = new Date(data);
    if (!isNaN(d.getTime())) return d;
  }

  // 2. The "Quando:" line of the event text (gcal-oauth keeps the time there).
  const quando = row.text.match(/\*\*Quando:\*\*\s*([^\n→]+)/);
  if (quando) {
    const raw = quando[1].trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 3. Date-only fallback (all-day events): treat as local midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    const d = new Date(`${data}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Pick the earliest event strictly in the future out of the candidate rows.
 * Exported pure for unit tests (the SQL layer just narrows the candidate set).
 */
export function pickNextMeeting(rows: CalendarEventRow[], now: Date = new Date()): NextMeeting {
  let best: { start: Date; row: CalendarEventRow } | null = null;
  for (const row of rows) {
    const start = parseEventStart(row);
    if (!start || start.getTime() <= now.getTime()) continue;
    if (!best || start.getTime() < best.start.getTime()) best = { start, row };
  }
  if (!best) return { found: false };

  const meta = best.row.metadata ?? {};
  const attendees = Array.isArray(meta.attendees)
    ? (meta.attendees as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const calendar =
    typeof meta.calendar_label === "string" && meta.calendar_label
      ? meta.calendar_label
      : best.row.db_name ?? null;
  return {
    found: true,
    title: titleFromHeaderLine(best.row.first_line),
    starts_at: best.start.toISOString(),
    calendar,
    attendees,
  };
}

/** The account's next future calendar event, or {found:false}. */
export async function getNextMeeting(
  accountId: string,
  now: Date = new Date(),
): Promise<NextMeeting> {
  const p = getPool();
  // Coarse SQL narrowing: events whose metadata date-prefix is today or later
  // (lexicographic compare works for both YYYY-MM-DD and full ISO). Precise
  // future filtering/parsing happens in pickNextMeeting.
  const today = now.toISOString().slice(0, 10);
  const { rows } = await p.query<{
    first_line: string | null;
    text: string;
    db_name: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT split_part(text, E'\n', 1) AS first_line, text, db_name, metadata
       FROM (
         SELECT DISTINCT ON (source_id) source_id, text, db_name, metadata
           FROM brain_chunks
          WHERE account_id = $1
            AND source_type = 'calendar'
            AND left(metadata->>'data', 10) >= $2
          ORDER BY source_id, chunk_index
       ) d
      LIMIT 500`,
    [accountId, today],
  );
  return pickNextMeeting(rows, now);
}
