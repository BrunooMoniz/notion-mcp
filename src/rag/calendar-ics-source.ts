// src/rag/calendar-ics-source.ts
// Pulls calendar events from per-calendar iCal (.ics) secret URLs and yields
// IndexableDocument records for the brain-indexer. No OAuth / Google Cloud: each
// calendar's private iCal URL is configured via the GOOGLE_CAL_ICS env var. This
// is the simple, account-agnostic way to index multiple calendars (even across
// different Google accounts) — it replaces the Google-OAuth calendar indexer.
//
// GOOGLE_CAL_ICS is a JSON array, e.g.:
//   [{"url":"https://calendar.google.com/calendar/ical/<id>/private-<key>/basic.ics",
//     "label":"Pessoal","workspace":"personal"},
//    {"url":"...","label":"Nora","workspace":"nora"}]
//
// Each .ics URL is a SECRET (anyone with it can read that calendar). Keep them in
// .env only (never commit). Reset a leaked URL in Google Calendar settings.

import ical from "node-ical";
import type { IndexableDocument, Workspace } from "./types.js";

export interface IcsCalendarConfig {
  url: string;
  label: string;
  workspace: Workspace;
}

const PAST_WINDOW_MS = 180 * 24 * 60 * 60_000; // keep recent past one-off events
const FUTURE_WINDOW_MS = 365 * 24 * 60 * 60_000; // and up to a year ahead
export const VALID_WORKSPACES: Workspace[] = ["personal", "globalcripto", "nora"];

export function parseIcsConfig(
  raw: string | undefined = process.env.GOOGLE_CAL_ICS,
): IcsCalendarConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[calendar-ics] GOOGLE_CAL_ICS is not valid JSON; ignoring");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[calendar-ics] GOOGLE_CAL_ICS must be a JSON array; ignoring");
    return [];
  }
  const out: IcsCalendarConfig[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const url = item?.url;
    const label = item?.label;
    const workspace = item?.workspace;
    if (
      typeof url === "string" &&
      typeof label === "string" &&
      typeof workspace === "string" &&
      VALID_WORKSPACES.includes(workspace as Workspace)
    ) {
      out.push({ url, label, workspace: workspace as Workspace });
    } else {
      console.warn("[calendar-ics] skipping malformed GOOGLE_CAL_ICS entry:", JSON.stringify(item));
    }
  }
  return out;
}

export function hasIcsCalendars(): boolean {
  return parseIcsConfig().length > 0;
}

// node-ical's parsed VEVENT has a loose shape; narrow only what we use.
interface IcsContact {
  params?: { CN?: string };
  val?: string;
}
interface IcsEvent {
  type?: string;
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  status?: string;
  start?: Date;
  end?: Date;
  datetype?: string; // "date" (all-day) | "date-time"
  organizer?: IcsContact | string;
  attendee?: Array<IcsContact | string> | IcsContact | string;
  url?: string;
  rrule?: { after(d: Date, inc?: boolean): Date | null };
}

function cleanContact(x: IcsContact | string | undefined): string | null {
  if (!x) return null;
  if (typeof x === "string") return x.replace(/^mailto:/i, "").trim() || null;
  const cn = x.params?.CN;
  const email = (x.val ?? "").replace(/^mailto:/i, "").trim();
  return cn || email || null;
}

function attendeeNames(ev: IcsEvent): string[] {
  const a = ev.attendee;
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.map(cleanContact).filter((s): s is string => !!s);
}

function fmtStart(d: Date | undefined, allDay: boolean): string {
  if (!d) return "";
  return allDay ? d.toISOString().slice(0, 10) : d.toISOString();
}

function eventText(
  ev: IcsEvent,
  label: string,
  effStart: Date | undefined,
  allDay: boolean,
  recurring: boolean,
): string {
  const lines: string[] = [];
  lines.push(`# ${ev.summary ?? "(sem título)"}`);
  const start = fmtStart(effStart, allDay);
  const end = ev.end ? fmtStart(ev.end, allDay) : "";
  if (start) lines.push(`**Quando:** ${start}${end ? ` → ${end}` : ""}${recurring ? " (recorrente)" : ""}`);
  lines.push(`**Calendário:** ${label}`);
  if (ev.location) lines.push(`**Local:** ${ev.location}`);
  const org = cleanContact(ev.organizer);
  if (org) lines.push(`**Organizer:** ${org}`);
  const names = attendeeNames(ev);
  if (names.length) lines.push(`**Attendees:** ${names.join(", ")}`);
  if (ev.status && ev.status.toLowerCase() !== "confirmed") lines.push(`**Status:** ${ev.status}`);
  if (ev.description) {
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

function eventMetadata(
  ev: IcsEvent,
  label: string,
  workspace: Workspace,
  effStart: Date | undefined,
  allDay: boolean,
): Record<string, unknown> {
  return {
    calendar_label: label,
    workspace,
    organizer_email: cleanContact(ev.organizer),
    attendees: attendeeNames(ev),
    location: ev.location ?? null,
    status: ev.status ?? null,
    htmlLink: ev.url ?? null,
    data: effStart ? fmtStart(effStart, allDay) : null,
  };
}

// Pure core: map already-parsed node-ical data to IndexableDocuments.
// `now` is injectable so tests are deterministic.
export function parsedToDocuments(
  parsed: Record<string, unknown>,
  cfg: IcsCalendarConfig,
  now: Date,
): IndexableDocument[] {
  const out: IndexableDocument[] = [];
  const pastCutoff = new Date(now.getTime() - PAST_WINDOW_MS);
  const futureCutoff = new Date(now.getTime() + FUTURE_WINDOW_MS);
  for (const key of Object.keys(parsed)) {
    const ev = parsed[key] as unknown as IcsEvent;
    if (ev.type !== "VEVENT") continue;
    if (!ev.uid) continue;
    if ((ev.status ?? "").toLowerCase() === "cancelled") continue;
    if (!ev.summary && !ev.description) continue;

    const allDay = ev.datetype === "date";
    const recurring = !!ev.rrule;
    // Effective start: next occurrence for recurring (so the date is useful),
    // else the event's own start.
    let effStart: Date | undefined = ev.start;
    if (recurring && ev.rrule) {
      const next = ev.rrule.after(now, true);
      if (next) effStart = next;
    }
    if (!effStart) continue;
    // One-off events must fall inside the window; recurring are always kept.
    if (!recurring && (effStart < pastCutoff || effStart > futureCutoff)) continue;

    const text = eventText(ev, cfg.label, effStart, allDay, recurring);
    if (!text.trim()) continue;

    out.push({
      source_type: "calendar",
      source_id: `ics:${cfg.label}::${ev.uid}`,
      workspace: cfg.workspace,
      db_name: "Calendar",
      parent_url: ev.url ?? "https://calendar.google.com/calendar/r",
      text,
      metadata: eventMetadata(ev, cfg.label, cfg.workspace, effStart, allDay),
      source_updated: now,
    });
  }
  return out;
}

// Parse raw .ics text (testable without network).
export function icsToDocuments(
  icsText: string,
  cfg: IcsCalendarConfig,
  now: Date = new Date(),
): IndexableDocument[] {
  const parsed = ical.sync.parseICS(icsText) as unknown as Record<string, unknown>;
  return parsedToDocuments(parsed, cfg, now);
}

export async function* fetchIcsCalendarDocuments(
  opts: { modifiedSince?: Date; configs?: IcsCalendarConfig[] } = {},
): AsyncGenerator<IndexableDocument> {
  // iCal has no server-side delta filter, so each run re-fetches the whole
  // calendar. delete-then-upsert by source_id keeps it consistent, and the
  // embedding cache makes unchanged events free to re-process.
  // Operator path reads configs from GOOGLE_CAL_ICS; per-account path (portal)
  // passes the friend's vault-stored iCal list directly via `configs`.
  const configs = opts.configs ?? parseIcsConfig();
  if (configs.length === 0) return;
  const now = new Date();
  for (const cfg of configs) {
    let docs: IndexableDocument[];
    try {
      const parsed = (await ical.async.fromURL(cfg.url)) as unknown as Record<string, unknown>;
      docs = parsedToDocuments(parsed, cfg, now);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[calendar-ics] fetch failed for "${cfg.label}": ${msg}`);
      continue;
    }
    console.log(`[calendar-ics] ${cfg.label} (${cfg.workspace}): ${docs.length} events`);
    for (const d of docs) yield d;
  }
}
