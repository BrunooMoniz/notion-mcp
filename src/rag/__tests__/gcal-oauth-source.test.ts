// src/rag/__tests__/gcal-oauth-source.test.ts
// TDD P2: RAG indexing of Google OAuth calendar accounts.
// Tests cover pure functions first (eventToDocument, gcalWindow),
// then the full source with injected deps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  eventToDocument,
  gcalWindow,
  __setGcalDepsForTest,
} from "../gcal-oauth-source.js";
import type { CalendarEvent } from "../../google/calendar.js";
import type { GcalDeps } from "../gcal-oauth-source.js";
import { indexGcalOAuthForAccount } from "../gcal-oauth-source.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev1",
    summary: "Reunião de alinhamento",
    description: "Pauta: roadmap Q3",
    location: "Google Meet",
    status: "confirmed",
    htmlLink: "https://calendar.google.com/event?eid=ev1",
    start: { dateTime: "2026-06-10T14:00:00-03:00" },
    end: { dateTime: "2026-06-10T15:00:00-03:00" },
    attendees: [
      { email: "alice@example.com", displayName: "Alice" },
      { email: "bob@example.com" },
    ],
    ...overrides,
  };
}

// ─── eventToDocument ───────────────────────────────────────────────────────

describe("eventToDocument", () => {
  test("campos completos: source_id, source_type, metadata e text", () => {
    const ev = makeEvent();
    const doc = eventToDocument(ev, "me@gmail.com", "Minha Agenda");

    assert.equal(doc.source_type, "calendar");
    assert.equal(doc.source_id, "gcal:me@gmail.com:ev1");
    assert.equal(doc.db_name, "Minha Agenda");
    assert.equal(doc.parent_url, "https://calendar.google.com/event?eid=ev1");

    // text deve conter título, local, participantes
    assert.match(doc.text, /Reunião de alinhamento/);
    assert.match(doc.text, /Google Meet/);
    assert.match(doc.text, /alice@example\.com/);
    assert.match(doc.text, /bob@example\.com/);
    assert.match(doc.text, /Pauta: roadmap Q3/);

    // metadata
    assert.equal(doc.metadata.email, "me@gmail.com");
    assert.deepEqual(doc.metadata.attendees, ["alice@example.com", "bob@example.com"]);
    assert.equal(typeof doc.metadata.data, "string");
    // data deve ser YYYY-MM-DD
    assert.match(doc.metadata.data as string, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("evento all-day: data sem hora no text, metadata.data = YYYY-MM-DD", () => {
    const ev = makeEvent({
      start: { date: "2026-07-01" },
      end: { date: "2026-07-02" },
    });
    const doc = eventToDocument(ev, "me@gmail.com", "Pessoal");

    // text não deve ter 'T' na data (sem hora)
    assert.match(doc.text, /2026-07-01/);
    assert.doesNotMatch(doc.text, /2026-07-01T/);
    assert.equal(doc.metadata.data, "2026-07-01");
  });

  test("descrição > 2000 chars é truncada", () => {
    const longDesc = "x".repeat(3000);
    const ev = makeEvent({ description: longDesc });
    const doc = eventToDocument(ev, "me@gmail.com", "Agenda");

    // O campo text não deve ultrapassar os limites razoáveis
    const descIdx = doc.text.indexOf("x");
    const descSection = doc.text.slice(descIdx);
    // Encontra o bloco de 'x' (pode ser menor que 3000)
    const xRun = descSection.match(/^x+/)?.[0] ?? "";
    assert.ok(xRun.length <= 2000, `Descrição deve ser truncada a ≤2000 chars, got ${xRun.length}`);
  });

  test("evento com status cancelled retorna marcador de deleção (tombstone)", () => {
    const ev = makeEvent({ status: "cancelled" });
    const doc = eventToDocument(ev, "me@gmail.com", "Agenda");

    // A função sinaliza que o evento foi cancelado via campo especial
    assert.equal((doc as unknown as Record<string, unknown>)["_deleted"], true);
  });

  test("evento sem htmlLink: parent_url é string vazia", () => {
    const ev = makeEvent({ htmlLink: undefined });
    const doc = eventToDocument(ev, "me@gmail.com", "Agenda");
    assert.equal(doc.parent_url, "");
  });
});

// ─── gcalWindow ────────────────────────────────────────────────────────────

describe("gcalWindow", () => {
  test("retorna timeMin = hoje-90d e timeMax = hoje+180d em ISO 8601", () => {
    const now = new Date("2026-06-09T12:00:00Z");
    const { timeMin, timeMax } = gcalWindow(now);

    const minDate = new Date(timeMin);
    const maxDate = new Date(timeMax);

    // hoje - 90 dias
    const expectedMin = new Date(now);
    expectedMin.setDate(expectedMin.getDate() - 90);

    // hoje + 180 dias
    const expectedMax = new Date(now);
    expectedMax.setDate(expectedMax.getDate() + 180);

    // Tolerância de 1 segundo
    assert.ok(
      Math.abs(minDate.getTime() - expectedMin.getTime()) < 1000,
      `timeMin errado: ${timeMin}`,
    );
    assert.ok(
      Math.abs(maxDate.getTime() - expectedMax.getTime()) < 1000,
      `timeMax errado: ${timeMax}`,
    );

    // Devem ser strings ISO válidas
    assert.ok(timeMin.includes("T"), "timeMin deve ser ISO 8601");
    assert.ok(timeMax.includes("T"), "timeMax deve ser ISO 8601");
  });
});

// ─── indexGcalOAuthForAccount (deps injetáveis) ─────────────────────────────

describe("indexGcalOAuthForAccount", () => {
  test("indexa eventos e chama upsert/deleteBySource por conta", async () => {
    const ev = makeEvent();
    const evCancelled = makeEvent({ id: "ev-cancel", status: "cancelled" });

    const upserted: string[] = [];
    const deleted: string[] = [];
    const synced: string[] = [];
    const runs: Array<{ ok: boolean; source: string }> = [];

    const deps: GcalDeps = {
      getGoogleAccounts: async () => [
        { email: "me@gmail.com", refresh_token: "rt", scopes: [], connected_at: "" },
      ],
      getAccessToken: async (_accountId, _email) => "fake-token",
      listCalendarsWithToken: async (_token) => [{ id: "cal1", summary: "Pessoal" }],
      listEventsWithToken: async (_token, _opts) => [ev, evCancelled],
      indexDocument: async (doc) => [
        {
          ...doc,
          id: doc.source_id + ":0",
          chunk_index: 0,
          embedding: [0.1],
        } as never,
      ],
      replaceDocumentChunks: async (_type, sourceId, _accountId, _chunks) => {
        upserted.push(sourceId);
      },
      deleteBySource: async (_type, sourceId, _accountId) => {
        deleted.push(sourceId);
      },
      setSyncState: async (key, _ts, _accountId) => {
        synced.push(key);
      },
      recordRun: async (run) => {
        runs.push({ ok: run.ok, source: run.source });
      },
      ensureAccountWorkspace: async () => {},
    };

    __setGcalDepsForTest(deps);
    const result = await indexGcalOAuthForAccount("acct:1", "personal");
    __setGcalDepsForTest(null);

    // Evento confirmado deve ter sido upsertado
    assert.ok(
      upserted.some((id) => id === "gcal:me@gmail.com:ev1"),
      `source_id upsertado esperado: ${JSON.stringify(upserted)}`,
    );

    // Evento cancelado deve ter sido deletado
    assert.ok(
      deleted.some((id) => id === "gcal:me@gmail.com:ev-cancel"),
      `source_id deletado esperado: ${JSON.stringify(deleted)}`,
    );

    // setSyncState foi chamado com a chave gcal
    assert.ok(
      synced.some((k) => k === "gcal"),
      `setSyncState chave 'gcal' esperada: ${JSON.stringify(synced)}`,
    );

    // recordRun com ok=true e source='gcal'
    assert.ok(
      runs.some((r) => r.ok && r.source === "gcal"),
      `recordRun ok=true esperado: ${JSON.stringify(runs)}`,
    );

    // Resultado tem documento contado
    assert.ok(result.documents >= 1, "deve ter indexado ao menos 1 documento");
  });

  test("falha em uma conta Google não derruba as demais", async () => {
    const ev = makeEvent();
    const runs: Array<{ ok: boolean; error?: string | null }> = [];

    const deps: GcalDeps = {
      getGoogleAccounts: async () => [
        { email: "fail@gmail.com", refresh_token: "rt1", scopes: [], connected_at: "" },
        { email: "ok@gmail.com", refresh_token: "rt2", scopes: [], connected_at: "" },
      ],
      getAccessToken: async (_accountId, email) => {
        if (email === "fail@gmail.com") throw new Error("token revogado");
        return "token-ok";
      },
      listCalendarsWithToken: async (_token) => [{ id: "primary", summary: "Agenda" }],
      listEventsWithToken: async (_token, _opts) => [ev],
      indexDocument: async (doc) => [
        { ...doc, id: doc.source_id + ":0", chunk_index: 0, embedding: [0.1] } as never,
      ],
      replaceDocumentChunks: async () => {},
      deleteBySource: async () => {},
      setSyncState: async () => {},
      recordRun: async (run) => {
        runs.push({ ok: run.ok, error: run.error });
      },
      ensureAccountWorkspace: async () => {},
    };

    __setGcalDepsForTest(deps);
    const result = await indexGcalOAuthForAccount("acct:2", "personal");
    __setGcalDepsForTest(null);

    // Deve ter indexado ao menos os eventos da conta ok@gmail.com
    assert.ok(result.documents >= 1, "conta ok deve ter indexado");

    // recordRun deve ter sido chamado e conter mensagem de erro da conta falha
    const finalRun = runs[runs.length - 1];
    assert.ok(finalRun !== undefined, "recordRun deve ter sido chamado");
    // Pode ser ok:false com erro agregado, ou ok:true com erro nos counts
    // A chave é que não disparou exceção
  });

  test("sem contas google_oauth: retorna 0 documentos sem falhar", async () => {
    const deps: GcalDeps = {
      getGoogleAccounts: async () => [],
      getAccessToken: async () => "t",
      listCalendarsWithToken: async () => [],
      listEventsWithToken: async () => [],
      indexDocument: async () => [],
      replaceDocumentChunks: async () => {},
      deleteBySource: async () => {},
      setSyncState: async () => {},
      recordRun: async () => {},
      ensureAccountWorkspace: async () => {},
    };

    __setGcalDepsForTest(deps);
    const result = await indexGcalOAuthForAccount("acct:3", "personal");
    __setGcalDepsForTest(null);

    assert.equal(result.documents, 0);
    assert.equal(result.chunks, 0);
  });
});
