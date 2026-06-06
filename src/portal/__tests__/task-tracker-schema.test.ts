// src/portal/__tests__/task-tracker-schema.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTaskTrackerCandidate,
  classifyResults,
  buildCreateDbPayload,
  buildParentPagePayload,
  TARGET_PROPERTIES,
} from "../task-tracker-schema.js";

const statusSelect = { Status: { type: "select", select: { options: [{ name: "A fazer" }] } } };
const dateProp = { Prazo: { type: "date", date: {} } };
const title = { Nome: { type: "title", title: {} } };

test("status-like + date-like → candidata, mesmo com nome neutro", () => {
  assert.equal(
    isTaskTrackerCandidate({ title: "Projetos 2026", properties: { ...title, ...statusSelect, ...dateProp } }),
    true,
  );
});

test("nome casa tarefa/task → candidata, mesmo sem status+date", () => {
  assert.equal(isTaskTrackerCandidate({ title: "Minhas Tarefas", properties: { ...title } }), true);
  assert.equal(isTaskTrackerCandidate({ title: "TO-DO", properties: { ...title } }), true);
  assert.equal(isTaskTrackerCandidate({ title: "Afazeres", properties: { ...title } }), true);
});

test("acento/caixa não atrapalham o nome", () => {
  assert.equal(isTaskTrackerCandidate({ title: "TAREFA", properties: {} }), true);
});

test("DB qualquer (sem nome nem status+date) NÃO é candidata", () => {
  assert.equal(
    isTaskTrackerCandidate({ title: "Notas", properties: { ...title, Texto: { type: "rich_text", rich_text: {} } } }),
    false,
  );
  // só date, sem status → não basta
  assert.equal(isTaskTrackerCandidate({ title: "Agenda", properties: { ...title, ...dateProp } }), false);
});

test("classifyResults conta candidatas: none / one / many", () => {
  const none = classifyResults([{ id: "a", title: "Notas", properties: { ...title } }]);
  assert.equal(none.status, "none");

  const one = classifyResults([
    { id: "a", title: "Notas", properties: { ...title } },
    { id: "b", title: "Tarefas", properties: { ...title } },
  ]);
  assert.equal(one.status, "one");
  assert.deepEqual(one.candidates, [{ id: "b", title: "Tarefas" }]);

  const many = classifyResults([
    { id: "b", title: "Tarefas", properties: { ...title } },
    { id: "c", title: "To-do", properties: { ...title } },
  ]);
  assert.equal(many.status, "many");
  assert.equal(many.candidates.length, 2);
});

test("buildParentPagePayload cria página no topo do workspace", () => {
  const p = buildParentPagePayload();
  assert.deepEqual(p.parent, { type: "workspace", workspace: true });
  assert.equal(p.properties.title.title[0].text.content, "🧠 Zinom");
});

test("buildCreateDbPayload usa o parent page e o schema-alvo em initial_data_source", () => {
  const p = buildCreateDbPayload("PAGE_ID");
  assert.deepEqual(p.parent, { type: "page_id", page_id: "PAGE_ID" });
  assert.equal(p.title[0].text.content, "Tarefas");
  // Notion 2025-09-03: o schema vive em initial_data_source.properties
  assert.equal(p.initial_data_source.properties, TARGET_PROPERTIES);
  for (const k of ["Nome", "Status", "Prazo", "Tempo estimado", "Frente"]) {
    assert.ok(k in TARGET_PROPERTIES, `falta ${k}`);
  }
  assert.equal(TARGET_PROPERTIES["Nome"].title !== undefined, true);
});
