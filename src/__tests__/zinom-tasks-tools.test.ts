// src/__tests__/zinom-tasks-tools.test.ts
// 003-tasks-v1 (review) — gatherEvents: união Google+brain sempre, exclusões de
// busy (transparent/declined/reader), mapper puro do fallback do brain (janela
// no tz do usuário, título sem header, approximate) e o contrato das tools
// (tipo aceita literal, create_failed, NoNotion ≠ NoTracker no plan_context).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);
// As tools resolvem o owner pelos tokens de .env — testes rodam sem credenciais.
delete process.env.NOTION_PERSONAL_TOKEN;
delete process.env.NOTION_GLOBALCRIPTO_TOKEN;
delete process.env.NOTION_NORA_TOKEN;

import {
  registerZinomTasksTools,
  gatherEvents,
  brainRowsToPlanEvents,
  busyCalendars,
  eventBlocksBusy,
  MAX_BUSY_CALENDARS,
} from "../zinom-tasks-tools.js";
import { dedupPlanEvents } from "../tasks/plan-context.js";
import { __clearTrackerProfileCache } from "../tasks/adapter.js";
import { __setPoolForTest } from "../rag/storage.js";

beforeEach(() => {
  __clearTrackerProfileCache();
  __setPoolForTest({ query: async () => ({ rows: [] }) } as never);
});
after(() => __setPoolForTest(null));

/** Captura os handlers/schemas registrados sem um McpServer real. */
function fakeServer() {
  const tools = new Map<string, { schema: any; handler: (args: any) => Promise<any> }>();
  const server = {
    tool: (name: string, _desc: string, schema: any, handler: any) =>
      tools.set(name, { schema, handler }),
  } as any;
  return { server, tools };
}

// --- K: exclusões de busy ------------------------------------------------------

test("eventBlocksBusy: transparent, declined e cancelled NÃO bloqueiam", () => {
  assert.equal(eventBlocksBusy({ summary: "normal" }), true);
  assert.equal(eventBlocksBusy({ transparency: "transparent" }), false);
  assert.equal(eventBlocksBusy({ status: "cancelled" }), false);
  assert.equal(
    eventBlocksBusy({ attendees: [{ self: true, responseStatus: "declined" }] }),
    false,
  );
  // declined de OUTRO participante não exclui
  assert.equal(
    eventBlocksBusy({ attendees: [{ self: false, responseStatus: "declined" }] }),
    true,
  );
});

test("busyCalendars: só owner/writer, cap de 10 por conta", () => {
  const cals = [
    { id: "own", accessRole: "owner" },
    { id: "wr", accessRole: "writer" },
    { id: "rd", accessRole: "reader" },
    { id: "fb", accessRole: "freeBusyReader" },
  ];
  assert.deepEqual(busyCalendars(cals, "t").map((c) => c.id), ["own", "wr"]);

  const many = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, accessRole: "owner" }));
  assert.equal(busyCalendars(many, "t").length, MAX_BUSY_CALENDARS);
});

// --- J: mapper puro do fallback do brain ----------------------------------------

const SP = "America/Sao_Paulo";

test("brainRowsToPlanEvents: 22h BRT armazenado como 01:00Z NÃO vaza pro dia seguinte", () => {
  const rows = [
    {
      text: "[Calendar · personal · 2026-06-15] Jantar\n\n# Jantar",
      data: "2026-06-16T01:00:00Z", // 2026-06-15 22:00 em SP
      calendar_label: "pessoal",
    },
  ];
  const inWindow = brainRowsToPlanEvents(rows, "2026-06-15", "2026-06-15", SP);
  assert.equal(inWindow.length, 1);
  assert.equal(inWindow[0].title, "Jantar"); // header de colchetes removido
  assert.equal(inWindow[0].start, "2026-06-15T22:00:00-03:00"); // offset do usuário
  assert.equal(inWindow[0].approximate, true);

  // Janela do dia 16: o evento pertence ao dia 15 LOCAL → fora.
  assert.deepEqual(brainRowsToPlanEvents(rows, "2026-06-16", "2026-06-16", SP), []);
});

test("brainRowsToPlanEvents: all-day mantém a data; sem data é ignorado", () => {
  const out = brainRowsToPlanEvents(
    [
      { text: "# Feriado", data: "2026-06-15", calendar_label: null },
      { text: "# Sem data", data: null, calendar_label: null },
    ],
    "2026-06-15",
    "2026-06-15",
    SP,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].all_day, true);
  assert.equal(out[0].start, "2026-06-15");
  assert.equal(out[0].title, "Feriado");
});

// --- H/K: gatherEvents — união sempre + calendários/eventos filtrados -------------

test("gatherEvents: brain entra em UNIÃO mesmo com Google ok; dedup resolve a sobreposição", async () => {
  const listEventsCalls: string[] = [];
  const events = await gatherEvents("acct-x", "2026-06-15", "2026-06-15", SP, {
    getGoogleAccounts: async () => [{ email: "a@x.com" }],
    getAccessToken: async () => "tok",
    listCalendars: async () => [
      { id: "cal1", summary: "Work", accessRole: "owner" },
      { id: "feed", summary: "Holidays", accessRole: "reader" }, // nunca consultado
    ],
    listEvents: async (_tok, opts) => {
      listEventsCalls.push(opts.calendarId);
      return [
        {
          summary: "Reunião X",
          start: { dateTime: "2026-06-15T14:00:00-03:00" },
          end: { dateTime: "2026-06-15T15:00:00-03:00" },
        },
        { summary: "Hold livre", transparency: "transparent", start: { dateTime: "2026-06-15T16:00:00-03:00" } },
        {
          summary: "Recusada",
          attendees: [{ self: true, responseStatus: "declined" }],
          start: { dateTime: "2026-06-15T17:00:00-03:00" },
        },
      ];
    },
    queryBrainRows: async () => [
      // Mesmo instante da Reunião X em outro offset → deve deduplicar (live vence).
      { text: "[Calendar · personal · 2026-06-15] Reunião X", data: "2026-06-15T17:00:00Z", calendar_label: "pessoal" },
      { text: "[Calendar · nora · 2026-06-15] Jantar", data: "2026-06-16T01:30:00Z", calendar_label: "nora" },
    ],
  });

  assert.deepEqual(listEventsCalls, ["cal1"], "reader não bloqueia slots");
  // União: live + brain (transparent/declined excluídos).
  assert.deepEqual(
    events.map((e) => e.title),
    ["Reunião X", "Reunião X", "Jantar"],
  );
  assert.equal(events[2].approximate, true);

  const deduped = dedupPlanEvents(events);
  assert.deepEqual(deduped.map((e) => e.title), ["Reunião X", "Jantar"]);
  assert.equal(deduped[0].calendar, "Work", "evento ao vivo vence o do índice");
});

test("gatherEvents: sem Google, fallback do brain segue funcionando sozinho", async () => {
  const events = await gatherEvents("acct-y", "2026-06-15", "2026-06-15", SP, {
    getGoogleAccounts: async () => [],
    queryBrainRows: async () => [
      { text: "[Calendar · personal · 2026-06-15] Daily", data: "2026-06-15T12:00:00Z", calendar_label: "p" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Daily");
  assert.equal(events[0].approximate, true);
});

// --- M/N/L: contrato das tools ----------------------------------------------------

function parsed(result: any): any {
  return JSON.parse(result.content[0].text);
}

test("zinom_create_task: falha genérica usa o código create_failed", async () => {
  const { server, tools } = fakeServer();
  registerZinomTasksTools(server);
  const r = parsed(await tools.get("zinom_create_task")!.handler({ titulo: "   " }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "create_failed");
  assert.match(r.message, /título obrigatório/);
});

test("tipo aceita literal da base (z.string, não enum) no create e no update", () => {
  const { server, tools } = fakeServer();
  registerZinomTasksTools(server);
  for (const name of ["zinom_create_task", "zinom_update_task"]) {
    const tipo = tools.get(name)!.schema.tipo;
    assert.equal(tipo._def.typeName, "ZodOptional", `${name}.tipo opcional`);
    assert.equal(tipo._def.innerType._def.typeName, "ZodString", `${name}.tipo é string`);
    assert.match(String(tipo.description ?? tipo._def.innerType.description ?? ""), /literal/);
  }
});

test("zinom_plan_context: sem Notion → tracker_note de CONECTAR o Notion (não a de criar tarefa)", async () => {
  const { server, tools } = fakeServer();
  registerZinomTasksTools(server);
  const r = parsed(
    await tools.get("zinom_plan_context")!.handler({
      period_start: "2026-06-15",
      period_end: "2026-06-15",
    }),
  );
  assert.equal(r.ok, true);
  assert.match(r.tracker_note, /não conectou um Notion/);
  assert.ok(!/primeira tarefa/.test(r.tracker_note), "não pode sugerir criar tarefa sem Notion");
  assert.equal(r.totals.tasks_truncated, false);
});
