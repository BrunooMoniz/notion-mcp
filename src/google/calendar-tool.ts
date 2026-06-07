// src/google/calendar-tool.ts
// 5 tools MCP de Google Calendar. Cola fina: a conta vem SEMPRE de getAccountId()
// (contexto confiável), nunca do input; o calendar_ref é validado contra as
// contas conectadas dessa conta (resolveCalendarRef). Cada handler tem try/catch
// próprio (amigos não recebem o wrapper de erro de tools.ts). delete exige confirm.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId } from "../context.js";
import { auditWrite } from "../audit.js";
import { getGoogleAccounts } from "./google-accounts.js";
import { getGoogleAccessTokenFor, resolveCalendarRef } from "./google-token.js";
import {
  listCalendarsWithToken,
  listEventsWithToken,
  createEvent,
  updateEvent,
  deleteEvent,
} from "./calendar.js";
import { encodeCalendarRef } from "./calendar-ref.js";
import { buildEventPayload, buildEventPatch } from "./event-payload.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fail(error: string, message: string) {
  return json({ ok: false, error, message });
}

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "list_calendars",
    `Lista as agendas (calendários) de TODAS as contas Google que a pessoa conectou no portal do Zinom. Use antes de criar/editar/excluir para descobrir o "calendar_ref" da agenda certa. Cada item traz calendar_ref (opaco, use exatamente como veio), summary (nome), email (qual conta Google), primary e accessRole. Se não vier nenhuma, a pessoa ainda não conectou um Google no portal.`,
    {},
    async () => {
      const accountId = getAccountId();
      try {
        const accounts = await getGoogleAccounts(accountId);
        const calendars: Array<Record<string, unknown>> = [];
        for (const acc of accounts) {
          try {
            const token = await getGoogleAccessTokenFor(accountId, acc.email);
            for (const c of await listCalendarsWithToken(token)) {
              calendars.push({
                calendar_ref: encodeCalendarRef(acc.email, c.id),
                summary: c.summary ?? c.id,
                email: acc.email,
                primary: !!c.primary,
                accessRole: c.accessRole,
              });
            }
          } catch (e: any) {
            calendars.push({ email: acc.email, error: e?.message ?? String(e) });
          }
        }
        return json({ ok: true, calendars });
      } catch (e: any) {
        return fail("list_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "list_events",
    `Lista eventos ao vivo de uma agenda num intervalo de tempo. Use calendar_ref vindo de list_calendars. time_min e time_max são ISO 8601 (ex.: "2026-06-09T00:00:00-03:00"). Calcule datas absolutas a partir de "hoje"/"amanhã"/"esta semana" usando a data atual.`,
    {
      calendar_ref: z.string().describe("O calendar_ref vindo de list_calendars"),
      time_min: z.string().describe("Início da janela, ISO 8601"),
      time_max: z.string().describe("Fim da janela, ISO 8601"),
    },
    async ({ calendar_ref, time_min, time_max }) => {
      const accountId = getAccountId();
      try {
        const { calendarId, token } = await resolveCalendarRef(accountId, calendar_ref);
        const events = await listEventsWithToken(token, { calendarId, timeMin: time_min, timeMax: time_max });
        return json({
          ok: true,
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            start: e.start,
            end: e.end,
            location: e.location,
            htmlLink: e.htmlLink,
          })),
        });
      } catch (e: any) {
        return fail("list_events_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "create_calendar_event",
    `Cria um evento numa agenda da pessoa. Use calendar_ref de list_calendars. start/end em ISO 8601 (com fuso, ex.: "2026-06-09T15:00:00-03:00"); para dia inteiro passe all_day=true e datas "YYYY-MM-DD". Calcule a data absoluta a partir de "amanhã 15h" etc. usando a data atual. Responde com o link do evento criado.`,
    {
      calendar_ref: z.string().describe("calendar_ref de list_calendars"),
      summary: z.string().min(1).describe("Título do evento"),
      start: z.string().describe("Início ISO 8601 (ou YYYY-MM-DD se all_day)"),
      end: z.string().describe("Fim ISO 8601 (ou YYYY-MM-DD se all_day)"),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Emails dos convidados"),
      timezone: z.string().optional().describe("IANA, ex.: America/Sao_Paulo"),
      all_day: z.boolean().optional(),
    },
    async (args) => {
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, args.calendar_ref);
        const body = buildEventPayload(args);
        const ev = await createEvent(token, calendarId, body);
        auditWrite("create_calendar_event", "google", { calendar: email, calendarId, event_id: ev.id }, { summary: args.summary });
        return json({ ok: true, id: ev.id, htmlLink: ev.htmlLink, message: "Evento criado." });
      } catch (e: any) {
        return fail("create_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "update_calendar_event",
    `Edita um evento existente. Use calendar_ref de list_calendars e event_id de list_events. Passe só os campos que mudam (summary, start, end, description, location, attendees, timezone, all_day).`,
    {
      calendar_ref: z.string(),
      event_id: z.string().describe("id do evento (de list_events)"),
      summary: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      timezone: z.string().optional(),
      all_day: z.boolean().optional(),
    },
    async (args) => {
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, args.calendar_ref);
        const patch = buildEventPatch(args);
        const ev = await updateEvent(token, calendarId, args.event_id, patch);
        auditWrite("update_calendar_event", "google", { calendar: email, calendarId, event_id: args.event_id });
        return json({ ok: true, id: ev.id, htmlLink: ev.htmlLink, message: "Evento atualizado." });
      } catch (e: any) {
        return fail("update_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "delete_calendar_event",
    `Exclui um evento. AÇÃO DESTRUTIVA: só executa com confirm=true. Use calendar_ref de list_calendars e event_id de list_events. Antes de chamar com confirm=true, confirme com a pessoa qual evento será excluído.`,
    {
      calendar_ref: z.string(),
      event_id: z.string(),
      confirm: z.boolean().describe("Precisa ser true para excluir de fato"),
    },
    async ({ calendar_ref, event_id, confirm }) => {
      if (!confirm) {
        return fail("confirm_required", "Para excluir, chame de novo com confirm=true após confirmar com a pessoa.");
      }
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, calendar_ref);
        await deleteEvent(token, calendarId, event_id);
        auditWrite("delete_calendar_event", "google", { calendar: email, calendarId, event_id });
        return json({ ok: true, message: "Evento excluído." });
      } catch (e: any) {
        return fail("delete_failed", e?.message ?? String(e));
      }
    },
  );
}
