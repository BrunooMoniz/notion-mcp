// src/google/event-payload.ts
// Builders puros do corpo de evento da Google Calendar API v3. Sem rede, sem
// estado — testáveis isolados (espelha buildTaskPagePayload). Datas vêm prontas
// em ISO 8601 (a tool instrui a IA a calcular a data absoluta).

export interface CreateEventInput {
  summary: string;
  start: string; // ISO datetime, ou YYYY-MM-DD se all_day
  end: string;
  description?: string;
  location?: string;
  attendees?: string[]; // emails
  timezone?: string; // IANA, ex.: America/Sao_Paulo
  all_day?: boolean;
}

function timePoint(value: string, allDay: boolean | undefined, tz: string | undefined) {
  if (allDay) return { date: value };
  return tz ? { dateTime: value, timeZone: tz } : { dateTime: value };
}

export function buildEventPayload(input: CreateEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: input.summary };
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  body.start = timePoint(input.start, input.all_day, input.timezone);
  body.end = timePoint(input.end, input.all_day, input.timezone);
  return body;
}

export interface UpdateEventInput {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timezone?: string;
  all_day?: boolean;
}

export function buildEventPatch(input: UpdateEventInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));
  if (input.start !== undefined) patch.start = timePoint(input.start, input.all_day, input.timezone);
  if (input.end !== undefined) patch.end = timePoint(input.end, input.all_day, input.timezone);
  return patch;
}
