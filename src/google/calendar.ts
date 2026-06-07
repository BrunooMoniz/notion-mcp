// src/google/calendar.ts
// Thin Google Calendar v3 API client. Uses the refresh-token-backed
// access_token from ./oauth.ts. Read-only.

import { getAccessToken } from "./oauth.js";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

async function calGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
  token?: string,
): Promise<T> {
  const t = token ?? (await getAccessToken());
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${CAL_BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Google Calendar ${resp.status}: ${text.slice(0, 300)}`);
    (e as any).status = resp.status;
    throw e;
  }
  return JSON.parse(text) as T;
}

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  selected?: boolean;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  iCalUID?: string;
  recurringEventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string; // confirmed/tentative/cancelled
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  created?: string;
  updated?: string;
  creator?: { email?: string; displayName?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
    organizer?: boolean;
    self?: boolean;
  }>;
  eventType?: string; // default, outOfOffice, focusTime, workingLocation, birthday
  transparency?: string;
  visibility?: string;
}

export async function listCalendars(): Promise<CalendarListEntry[]> {
  const resp = await calGet<{ items?: CalendarListEntry[] }>("/users/me/calendarList", {
    minAccessRole: "reader",
    maxResults: 250,
  });
  return resp.items ?? [];
}

interface EventsResp {
  items?: CalendarEvent[];
  nextPageToken?: string;
}

export async function* iterEvents(opts: {
  calendarId: string;
  timeMin: string; // ISO
  timeMax: string; // ISO
  pageSize?: number;
}): AsyncGenerator<CalendarEvent> {
  let pageToken: string | undefined = undefined;
  for (;;) {
    const resp: EventsResp = await calGet<EventsResp>(
      `/calendars/${encodeURIComponent(opts.calendarId)}/events`,
      {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: opts.pageSize ?? 250,
        pageToken,
      },
    );
    for (const ev of resp.items ?? []) yield ev;
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
}

// --- Escrita + leitura com token explícito (multi-conta) --------------------

async function calSend<T>(
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | null> {
  const resp = await fetch(`${CAL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Google Calendar ${resp.status}: ${text.slice(0, 300)}`);
    (e as any).status = resp.status;
    throw e;
  }
  return text ? (JSON.parse(text) as T) : null;
}

export async function listCalendarsWithToken(token: string): Promise<CalendarListEntry[]> {
  const resp = await calGet<{ items?: CalendarListEntry[] }>(
    "/users/me/calendarList",
    { minAccessRole: "reader", maxResults: 250 },
    token,
  );
  return resp.items ?? [];
}

export async function listEventsWithToken(
  token: string,
  opts: { calendarId: string; timeMin: string; timeMax: string; pageSize?: number },
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined = undefined;
  for (;;) {
    const resp: EventsResp = await calGet<EventsResp>(
      `/calendars/${encodeURIComponent(opts.calendarId)}/events`,
      {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: opts.pageSize ?? 250,
        pageToken,
      },
      token,
    );
    for (const ev of resp.items ?? []) out.push(ev);
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return out;
}

export async function createEvent(
  token: string,
  calendarId: string,
  body: Record<string, unknown>,
): Promise<CalendarEvent> {
  return (await calSend<CalendarEvent>(
    token,
    "POST",
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    body,
  ))!;
}

export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<CalendarEvent> {
  return (await calSend<CalendarEvent>(
    token,
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    patch,
  ))!;
}

export async function deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
  await calSend(
    token,
    "DELETE",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}
