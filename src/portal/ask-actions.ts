// src/portal/ask-actions.ts
// E3 — Parser de datas PT-BR e executor de ações (criar evento/tarefa/página).
// Separado de ask.ts para manter tamanho controlado e testabilidade isolada.

import { auditWrite } from "../audit.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const TZ_OFFSET = "-03:00"; // BRT (America/Sao_Paulo, sem ajuste de DST para MVP)
const IANA_TZ = "America/Sao_Paulo";

// ---------------------------------------------------------------------------
// parseDataHoraPtBr — Parser de data/hora em PT-BR → ISO 8601 com fuso
// ---------------------------------------------------------------------------

const WEEKDAYS_PT: Record<string, number> = {
  domingo: 0, dom: 0,
  segunda: 1, seg: 1,
  "segunda-feira": 1,
  "terca": 2, ter: 2,
  "terça": 2,
  "terca-feira": 2,
  "terça-feira": 2,
  quarta: 3, qua: 3,
  "quarta-feira": 3,
  quinta: 4, qui: 4,
  "quinta-feira": 4,
  sexta: 5, sex: 5,
  "sexta-feira": 5,
  "sabado": 6, sab: 6,
  "sábado": 6,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build ISO datetime string with BRT offset from a UTC base date + local time. */
function toLocalISO(utcBaseDate: Date, hour: number, minute: number): string {
  const y = utcBaseDate.getUTCFullYear();
  const m = pad2(utcBaseDate.getUTCMonth() + 1);
  const d = pad2(utcBaseDate.getUTCDate());
  return `${y}-${m}-${d}T${pad2(hour)}:${pad2(minute)}:00${TZ_OFFSET}`;
}

/**
 * Parse a PT-BR date/time expression into ISO 8601 with BRT offset.
 * Pure function, no side-effects — injectable `now` for tests.
 *
 * Supported day forms (case-insensitive):
 *   hj, hoje, amanhã, amanha, dia da semana (seg, sex, quarta, …)
 *
 * Supported time forms:
 *   HHh, HHhMM, HH:MM
 *
 * If no time is given → date-only (dateOnly: true).
 * If no day is given  → assumes today.
 */
export function parseDataHoraPtBr(
  input: string,
  opts: { now?: Date } = {},
): { iso: string; dateOnly: boolean } {
  const now = opts.now ?? new Date();
  // Normalize: lowercase, NFC, strip leading "às " (common in PT)
  const raw = input
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/^às\s+/, "")
    .replace(/\bàs\s+/g, " ");

  // Compute local (BRT = UTC-3) "today" as a UTC midnight
  const localOffsetMs = 3 * 3600 * 1000;
  const localMs = now.getTime() - localOffsetMs;
  const localNow = new Date(localMs);
  const todayUtcMidnight = new Date(
    Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()),
  );
  const todayWeekday = localNow.getUTCDay();

  // --- Parse time component ---
  // Patterns: "9h", "09h", "9h30", "09h30", "9:00", "09:00", "9:30"
  const timeRe = /(\d{1,2})h(\d{2})?|(\d{1,2}):(\d{2})/;
  const timeMatch = raw.match(timeRe);
  let hour = -1;
  let minute = 0;

  if (timeMatch) {
    if (timeMatch[1] !== undefined) {
      hour = parseInt(timeMatch[1], 10);
      minute = timeMatch[2] !== undefined ? parseInt(timeMatch[2], 10) : 0;
    } else {
      hour = parseInt(timeMatch[3], 10);
      minute = parseInt(timeMatch[4], 10);
    }
  }

  // --- Parse date component ---
  let baseDate = todayUtcMidnight;

  if (/^(hj|hoje)(\s|$)/.test(raw) || raw === "hj" || raw === "hoje") {
    // today — baseDate already set
  } else if (/^amanh[aã](\s|$)/.test(raw) || raw === "amanhã" || raw === "amanha") {
    baseDate = new Date(todayUtcMidnight.getTime() + 86400000);
  } else {
    // Try weekday names (longest match first to avoid partial matches)
    const sortedWeekdays = Object.keys(WEEKDAYS_PT).sort((a, b) => b.length - a.length);
    let matched = false;
    for (const name of sortedWeekdays) {
      // Match at start of string or after a space
      if (raw.startsWith(name) || raw.includes(` ${name}`) || raw.startsWith(`${name} `)) {
        const targetDay = WEEKDAYS_PT[name];
        let diff = targetDay - todayWeekday;
        if (diff <= 0) diff += 7; // always move forward to the next occurrence
        baseDate = new Date(todayUtcMidnight.getTime() + diff * 86400000);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Check explicit date: DD/MM or DD/MM/YYYY
      const dateMatch = raw.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
      if (dateMatch) {
        const dayN = parseInt(dateMatch[1], 10);
        const monN = parseInt(dateMatch[2], 10) - 1;
        const yearN = dateMatch[3] ? parseInt(dateMatch[3], 10) : localNow.getUTCFullYear();
        baseDate = new Date(Date.UTC(yearN, monN, dayN));
      }
      // else: time-only input → treat as today (baseDate = todayUtcMidnight)
    }
  }

  // --- Build output ---
  if (hour < 0) {
    // Date-only
    const y = baseDate.getUTCFullYear();
    const m = pad2(baseDate.getUTCMonth() + 1);
    const d = pad2(baseDate.getUTCDate());
    return { iso: `${y}-${m}-${d}`, dateOnly: true };
  }

  return { iso: toLocalISO(baseDate, hour, minute), dateOnly: false };
}

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export interface ActionIntent {
  type: "criar_evento" | "criar_tarefa" | "criar_pagina_notion";
  params: Record<string, unknown>;
  resumo: string;
}

export type ExecuteResult =
  | { ok: true; message: string; url?: string }
  | { ok: false; error: string; message: string };

// ---------------------------------------------------------------------------
// Dependency injection for tests
// ---------------------------------------------------------------------------

export interface ExecuteDeps {
  createTaskPage?: (
    accountId: string,
    input: { title: string; date?: string; endDate?: string; status?: string; note?: string },
  ) => Promise<{ pageId: string; url: string | null; dataSourceId: string; created: boolean }>;
  getGoogleAccounts?: (accountId: string) => Promise<Array<{ email: string }>>;
  resolveCalendarRef?: (
    accountId: string,
    ref: string,
  ) => Promise<{ email: string; calendarId: string; token: string }>;
  createEvent?: (
    token: string,
    calendarId: string,
    body: Record<string, unknown>,
  ) => Promise<{ id: string; htmlLink?: string }>;
  buildEventPayload?: (input: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    timezone?: string;
    all_day?: boolean;
  }) => Record<string, unknown>;
  createNotionPage?: (
    accountId: string,
    input: { title: string; content?: string },
  ) => Promise<{ url: string | null }>;
}

// ---------------------------------------------------------------------------
// executeAction — execute a proposed action in the account's context
// ---------------------------------------------------------------------------

export async function executeAction(
  accountId: string,
  action: ActionIntent,
  deps: ExecuteDeps = {},
  opts: { now?: Date } = {},
): Promise<ExecuteResult> {
  auditWrite("portal_ask_execute", "portal", {
    account_id: accountId,
    action_type: action.type,
  });

  try {
    // --- criar_tarefa ---
    if (action.type === "criar_tarefa") {
      const fn =
        deps.createTaskPage ??
        (await import("./task-write.js")).createTaskPage;

      const title = String(
        action.params.titulo ?? action.params.title ?? action.resumo,
      );

      let date: string | undefined;
      if (action.params.date_raw) {
        date = parseDataHoraPtBr(String(action.params.date_raw), opts).iso;
      } else if (action.params.date) {
        date = String(action.params.date);
      }

      const note =
        typeof action.params.note === "string" ? action.params.note : undefined;

      const r = await fn(accountId, { title, date, note });
      return {
        ok: true,
        message: r.created
          ? "Criei sua base de Tarefas no Notion e adicionei a tarefa."
          : "Tarefa criada no seu Notion.",
        url: r.url ?? undefined,
      };
    }

    // --- criar_evento ---
    if (action.type === "criar_evento") {
      const getAccounts =
        deps.getGoogleAccounts ??
        (await import("../google/google-accounts.js")).getGoogleAccounts;

      const accounts = await getAccounts(accountId);
      if (accounts.length === 0) {
        return {
          ok: false,
          error: "no_google",
          message:
            "Você ainda não conectou uma conta Google. Abra o portal (zinom.ai) e conecte seu Google Calendar.",
        };
      }

      const resolveRef =
        deps.resolveCalendarRef ??
        (await import("../google/google-token.js")).resolveCalendarRef;
      const createEv =
        deps.createEvent ?? (await import("../google/calendar.js")).createEvent;
      const buildPayload =
        deps.buildEventPayload ??
        (await import("../google/event-payload.js")).buildEventPayload;
      const { encodeCalendarRef } = await import("../google/calendar-ref.js");

      const primaryRef = encodeCalendarRef(accounts[0].email, "primary");
      const { token, calendarId } = await resolveRef(accountId, primaryRef);

      const summary = String(
        action.params.summary ?? action.params.titulo ?? action.resumo,
      );
      const dateRaw = String(
        action.params.date_raw ?? action.params.start ?? "hoje",
      );
      const parsed = parseDataHoraPtBr(dateRaw, opts);
      const start = parsed.iso;

      // Default end: 1 hour later (or same date if date-only)
      const end = parsed.dateOnly
        ? start
        : (() => {
            const [datePart, timePart] = start.split("T");
            const [hh, mmAndRest] = timePart.split(":");
            const endHour = Math.min(parseInt(hh, 10) + 1, 23);
            return `${datePart}T${pad2(endHour)}:${mmAndRest}`;
          })();

      const body = buildPayload({
        summary,
        start,
        end,
        description:
          typeof action.params.description === "string"
            ? action.params.description
            : undefined,
        timezone: IANA_TZ,
        all_day: parsed.dateOnly,
      });

      const ev = await createEv(token, calendarId, body);
      auditWrite("create_calendar_event", "google", {
        account_id: accountId,
        calendar: accounts[0].email,
      });

      return {
        ok: true,
        message: `Evento "${summary}" criado no Google Calendar.`,
        url: ev.htmlLink,
      };
    }

    // --- criar_pagina_notion ---
    if (action.type === "criar_pagina_notion") {
      const title = String(
        action.params.titulo ?? action.params.title ?? action.resumo,
      );

      if (deps.createNotionPage) {
        const r = await deps.createNotionPage(accountId, {
          title,
          content:
            typeof action.params.content === "string"
              ? action.params.content
              : undefined,
        });
        return {
          ok: true,
          message: `Página "${title}" criada no Notion.`,
          url: r.url ?? undefined,
        };
      }

      // Production path: create via task-write infrastructure (Notion page)
      const { createTaskPage: ctp } = await import("./task-write.js");
      const r = await ctp(accountId, {
        title,
        note:
          typeof action.params.content === "string"
            ? action.params.content
            : undefined,
      });
      return {
        ok: true,
        message: `Página "${title}" criada no Notion.`,
        url: r.url ?? undefined,
      };
    }

    return {
      ok: false,
      error: "unknown_action",
      message: `Tipo de ação desconhecido: ${action.type}`,
    };
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // Detect NoNotionError by name or message pattern
    const isNoNotion =
      e?.name === "NoNotionError" ||
      (msg.includes("conecte") && msg.toLowerCase().includes("notion"));
    return {
      ok: false,
      error: isNoNotion ? "no_notion" : "execute_failed",
      message: isNoNotion
        ? "Você ainda não conectou um Notion. Abra o portal (zinom.ai) e conecte seu Notion."
        : `Não consegui executar a ação: ${msg}`,
    };
  }
}
