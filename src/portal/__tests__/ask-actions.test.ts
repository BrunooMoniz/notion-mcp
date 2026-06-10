// src/portal/__tests__/ask-actions.test.ts
// E3 — Testes do parser de datas PT-BR e do executor de ações.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDataHoraPtBr, executeAction } from "../ask-actions.js";

// ---------------------------------------------------------------------------
// parseDataHoraPtBr
// ---------------------------------------------------------------------------

// Referência fixa: quarta-feira, 2026-06-10, 12:00 UTC = 09:00 BRT
const REF = new Date("2026-06-10T12:00:00Z");

test("parseDataHoraPtBr: 'hj 22h' → hoje às 22:00 BRT", () => {
  const r = parseDataHoraPtBr("hj 22h", { now: REF });
  assert.equal(r.iso, "2026-06-10T22:00:00-03:00");
  assert.equal(r.dateOnly, false);
});

test("parseDataHoraPtBr: 'hoje às 9h' → hoje às 09:00 BRT", () => {
  const r = parseDataHoraPtBr("hoje às 9h", { now: REF });
  assert.equal(r.iso, "2026-06-10T09:00:00-03:00");
  assert.equal(r.dateOnly, false);
});

test("parseDataHoraPtBr: 'amanhã 14h30' → amanhã às 14:30 BRT", () => {
  const r = parseDataHoraPtBr("amanhã 14h30", { now: REF });
  assert.equal(r.iso, "2026-06-11T14:30:00-03:00");
  assert.equal(r.dateOnly, false);
});

test("parseDataHoraPtBr: 'amanhã 9h' → amanhã às 09:00 BRT", () => {
  const r = parseDataHoraPtBr("amanhã 9h", { now: REF });
  assert.equal(r.iso, "2026-06-11T09:00:00-03:00");
});

test("parseDataHoraPtBr: 'sex 9h' → próxima sexta às 09:00 (REF=qua→sex mesmo semana)", () => {
  // REF é quarta-feira (2026-06-10), próxima sexta = 2026-06-12
  const r = parseDataHoraPtBr("sex 9h", { now: REF });
  assert.equal(r.iso, "2026-06-12T09:00:00-03:00");
  assert.equal(r.dateOnly, false);
});

test("parseDataHoraPtBr: 'sexta 14:00' → próxima sexta às 14:00", () => {
  const r = parseDataHoraPtBr("sexta 14:00", { now: REF });
  assert.equal(r.iso, "2026-06-12T14:00:00-03:00");
});

test("parseDataHoraPtBr: 'terça 8h30' → próxima terça às 08:30 (REF=qua → terça seguinte)", () => {
  // REF=quarta, terça diff = 2 - 3 = -1 → +7 - 1 = 6 dias → 2026-06-16
  const r = parseDataHoraPtBr("terça 8h30", { now: REF });
  assert.equal(r.iso, "2026-06-16T08:30:00-03:00");
});

test("parseDataHoraPtBr: 'seg 10h' → próxima segunda (REF=qua → +5 dias)", () => {
  // REF=quarta(3), segunda(1): diff = 1-3=-2 → +7-2=5 → 2026-06-15
  const r = parseDataHoraPtBr("seg 10h", { now: REF });
  assert.equal(r.iso, "2026-06-15T10:00:00-03:00");
});

test("parseDataHoraPtBr: sem hora → retorna date-only (dateOnly=true)", () => {
  const r = parseDataHoraPtBr("amanhã", { now: REF });
  assert.equal(r.iso, "2026-06-11");
  assert.equal(r.dateOnly, true);
});

test("parseDataHoraPtBr: 'hj' (sem hora) → data de hoje", () => {
  const r = parseDataHoraPtBr("hj", { now: REF });
  assert.equal(r.iso, "2026-06-10");
  assert.equal(r.dateOnly, true);
});

test("parseDataHoraPtBr: '15h' (sem dia) → hoje às 15:00", () => {
  const r = parseDataHoraPtBr("15h", { now: REF });
  assert.equal(r.iso, "2026-06-10T15:00:00-03:00");
  assert.equal(r.dateOnly, false);
});

test("parseDataHoraPtBr: '09:30' → hoje às 09:30 (formato HH:MM)", () => {
  const r = parseDataHoraPtBr("09:30", { now: REF });
  assert.equal(r.iso, "2026-06-10T09:30:00-03:00");
});

test("parseDataHoraPtBr: case insensitive ('AMANHÃ 22H')", () => {
  const r = parseDataHoraPtBr("AMANHÃ 22H", { now: REF });
  assert.equal(r.iso, "2026-06-11T22:00:00-03:00");
});

// ---------------------------------------------------------------------------
// executeAction — testes com deps mockadas
// ---------------------------------------------------------------------------

test("executeAction criar_tarefa: chama createTaskPage e retorna url", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_tarefa", params: { titulo: "Estudar TypeScript", date_raw: "hj 22h" }, resumo: "Estudar TypeScript" },
    {
      createTaskPage: async (_id, input) => {
        assert.equal(input.title, "Estudar TypeScript");
        assert.equal(input.date, "2026-06-10T22:00:00-03:00");
        return { pageId: "pg-1", url: "https://notion.so/pg-1", dataSourceId: "ds-1", created: false };
      },
    },
    { now: REF },
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.url, "https://notion.so/pg-1");
});

test("executeAction criar_tarefa: created=true → mensagem diferente", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_tarefa", params: { titulo: "Tarefa X" }, resumo: "Tarefa X" },
    {
      createTaskPage: async () => ({
        pageId: "pg-2",
        url: "https://notion.so/pg-2",
        dataSourceId: "ds-2",
        created: true,
      }),
    },
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.ok(r.message.toLowerCase().includes("criei"), `msg deve mencionar 'criei', foi: ${r.message}`);
});

test("executeAction criar_evento: sem conta Google → erro no_google", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_evento", params: { summary: "Reunião" }, resumo: "Reunião" },
    { getGoogleAccounts: async () => [] },
  );
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.error, "no_google");
});

test("executeAction criar_evento: com conta Google → chama createEvent", async () => {
  let eventCreated = false;
  const r = await executeAction(
    "friend:test",
    { type: "criar_evento", params: { summary: "Standup", date_raw: "amanhã 9h" }, resumo: "Standup amanhã 9h" },
    {
      getGoogleAccounts: async () => [{ email: "user@example.com" }],
      resolveCalendarRef: async () => ({ email: "user@example.com", calendarId: "primary", token: "tok-abc" }),
      createEvent: async (_token, _calId, body) => {
        eventCreated = true;
        assert.equal(body.summary, "Standup");
        return { id: "ev-1", htmlLink: "https://calendar.google.com/event/ev-1" };
      },
      buildEventPayload: (input) => ({ summary: input.summary, start: input.start, end: input.end }),
    },
    { now: REF },
  );
  assert.equal(r.ok, true);
  assert.equal(eventCreated, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.url, "https://calendar.google.com/event/ev-1");
});

test("executeAction criar_pagina_notion: chama createNotionPage", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_pagina_notion", params: { titulo: "Nova Página", content: "Conteúdo inicial" }, resumo: "Nova Página" },
    {
      createNotionPage: async (_id, input) => {
        assert.equal(input.title, "Nova Página");
        return { url: "https://notion.so/nova-pagina" };
      },
    },
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.url, "https://notion.so/nova-pagina");
});

test("executeAction: erro em createTaskPage → retorna execute_failed", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_tarefa", params: { titulo: "Vai falhar" }, resumo: "Vai falhar" },
    {
      createTaskPage: async () => { throw new Error("DB down"); },
    },
  );
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.error, "execute_failed");
});

test("executeAction: NoNotionError → retorna no_notion", async () => {
  const r = await executeAction(
    "friend:test",
    { type: "criar_tarefa", params: { titulo: "Sem Notion" }, resumo: "Sem Notion" },
    {
      createTaskPage: async () => {
        const e = new Error("conecte seu Notion no portal antes");
        e.name = "NoNotionError";
        throw e;
      },
    },
  );
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.error, "no_notion");
});
