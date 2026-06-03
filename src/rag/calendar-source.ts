// src/rag/calendar-source.ts
// Pulls Google Calendar events (read-only) and yields IndexableDocument
// records for the brain-indexer. Auth is the shared Google refresh token
// configured via /google/connect.
//
// Window: indexer passes modifiedSince + a forward horizon. The default
// pull spans past 90d → future 30d (events updated after lastSync are
// included; recurring expanded as singleEvents).

import { hasCreds } from "../google/oauth.js";
import { listCalendars, iterEvents, type CalendarEvent } from "../google/calendar.js";
import type { IndexableDocument, Workspace } from "./types.js";

interface FetchOpts {
  modifiedSince?: Date;
}

interface CalendarMapEntry {
  workspace: Workspace;
  label?: string;
}

function getWorkspaceMap(): Record<string, CalendarMapEntry> {
  // NOTION_EXTRA_DATA_SOURCES-style env: GOOGLE_CAL_WORKSPACE_MAP, e.g.
  //   {"bruno.moniz@globalcripto.com":{"workspace":"globalcripto"},
  //    "brunoomoniz@gmail.com":{"workspace":"personal"}}
  const raw = process.env.GOOGLE_CAL_WORKSPACE_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CalendarMapEntry | string>;
    const out: Record<string, CalendarMapEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = { workspace: v as Workspace };
      else if (v && typeof v.workspace === "string") out[k] = v;
    }
    return out;
  } catch {
    console.warn("[calendar-source] GOOGLE_CAL_WORKSPACE_MAP is not valid JSON; ignoring");
    return {};
  }
}

function workspaceFor(calendarId: string, map: Record<string, CalendarMapEntry>): Workspace {
  if (map[calendarId]?.workspace) return map[calendarId].workspace;
  if (calendarId.includes("@globalcripto.com")) return "globalcripto";
  return "personal";
}

function eventText(ev: CalendarEvent, calendarLabel: string): string {
  const lines: string[] = [];
  lines.push(`# ${ev.summary ?? "(sem título)"}`);
  const start = ev.start?.dateTime ?? ev.start?.date ?? "";
  const end = ev.end?.dateTime ?? ev.end?.date ?? "";
  if (start || end) lines.push(`**Quando:** ${start} → ${end}`);
  lines.push(`**Calendário:** ${calendarLabel}`);
  if (ev.location) lines.push(`**Local:** ${ev.location}`);
  if (ev.organizer?.email) {
    lines.push(`**Organizer:** ${ev.organizer.displayName ?? ""} <${ev.organizer.email}>`);
  }
  if (ev.attendees?.length) {
    const list = ev.attendees
      .map((a) => `${a.displayName ?? a.email ?? ""}${a.responseStatus ? ` (${a.responseStatus})` : ""}`)
      .filter((s) => s.trim())
      .join(", ");
    if (list) lines.push(`**Attendees:** ${list}`);
  }
  if (ev.status && ev.status !== "confirmed") lines.push(`**Status:** ${ev.status}`);
  if (ev.eventType && ev.eventType !== "default") lines.push(`**Tipo:** ${ev.eventType}`);
  if (ev.hangoutLink) lines.push(`**Meet:** ${ev.hangoutLink}`);
  else if (ev.conferenceData?.entryPoints?.length) {
    const conf = ev.conferenceData.entryPoints.find((e) => e.uri);
    if (conf?.uri) lines.push(`**Conferência:** ${conf.uri}`);
  }
  if (ev.description) {
    // Strip HTML tags coarsely; calendar descriptions often carry html
    const desc = ev.description
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (desc) {
      lines.push("");
      lines.push("## Descrição");
      lines.push(desc.slice(0, 4000));
    }
  }
  return lines.join("\n");
}

function eventMetadata(ev: CalendarEvent, calendarId: string, calendarLabel: string): Record<string, unknown> {
  // F.3.3: tag the effective date so the `data` filter (COALESCE over
  // metadata.data) works for Calendar. The event start is its date.
  const start = ev.start?.dateTime ?? ev.start?.date ?? null;
  return {
    calendar_id: calendarId,
    calendar_label: calendarLabel,
    organizer_email: ev.organizer?.email,
    attendees: (ev.attendees ?? [])
      .map((a) => a.displayName || a.email)
      .filter(Boolean),
    location: ev.location,
    status: ev.status,
    event_type: ev.eventType,
    htmlLink: ev.htmlLink,
    recurring_id: ev.recurringEventId,
    data: start,
  };
}

function shouldIndex(ev: CalendarEvent): boolean {
  if (ev.status === "cancelled") return false;
  // Skip "private busy" placeholders with no useful metadata
  if (ev.eventType === "workingLocation") return false;
  if (!ev.summary && !ev.description) return false;
  return true;
}

export async function* fetchCalendarDocuments(
  opts: FetchOpts = {},
): AsyncGenerator<IndexableDocument> {
  if (!hasCreds()) {
    console.warn("[calendar-source] no Google credentials — visit /google/connect");
    return;
  }
  const map = getWorkspaceMap();

  // Past window: 90 days back from lastSync OR from now
  const baseline = opts.modifiedSince ?? new Date(Date.now() - 90 * 24 * 60 * 60_000);
  const timeMin = new Date(baseline.getTime() - 90 * 24 * 60 * 60_000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();

  let calendars: Array<{ id: string; label: string }>;
  try {
    const list = await listCalendars();
    calendars = list
      .filter((c) => {
        const s = (c.summary ?? "").toLowerCase();
        // Drop noise calendars
        if (s.includes("holiday")) return false;
        if (s.includes("birthday")) return false;
        return true;
      })
      .map((c) => ({ id: c.id, label: c.summary ?? c.id }));
  } catch (err: any) {
    console.error(`[calendar-source] listCalendars failed: ${err.message ?? err}`);
    return;
  }

  console.log(`[calendar-source] calendars=${calendars.length} window=${timeMin}→${timeMax}`);

  for (const cal of calendars) {
    const ws = workspaceFor(cal.id, map);
    let count = 0;
    try {
      for await (const ev of iterEvents({ calendarId: cal.id, timeMin, timeMax })) {
        if (!shouldIndex(ev)) continue;
        // Only re-yield events that have meaningfully changed since lastSync
        if (opts.modifiedSince) {
          const updated = ev.updated ? new Date(ev.updated) : null;
          if (updated && updated < opts.modifiedSince) continue;
        }
        const text = eventText(ev, cal.label);
        if (!text.trim()) continue;
        const startIso = ev.start?.dateTime ?? ev.start?.date ?? ev.created ?? new Date().toISOString();
        yield {
          source_type: "calendar",
          source_id: `${cal.id}::${ev.id}`,
          workspace: ws,
          db_name: "Calendar",
          parent_url: ev.htmlLink ?? `https://calendar.google.com/calendar/u/0/r/eventedit/${ev.id}`,
          text,
          metadata: eventMetadata(ev, cal.id, cal.label),
          source_updated: ev.updated ? new Date(ev.updated) : new Date(startIso),
        };
        count += 1;
      }
      console.log(`[calendar-source] ${cal.label} (${ws}): ${count} events`);
    } catch (err: any) {
      console.warn(`[calendar-source] calendar "${cal.label}" failed: ${err.message ?? err}`);
    }
  }
}
