// src/portal/__tests__/task-tracker-schema.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTaskTrackerCandidate,
  classifyResults,
  findReusableTrackerId,
  buildCreateDbPayload,
  buildParentPagePayload,
  extractNotionPageId,
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

test("findReusableTrackerId: reusa nossa DB 'Tarefas' (exata, acento/caixa), senão null", () => {
  assert.equal(findReusableTrackerId([{ id: "a", title: "Notas" }, { id: "b", title: "TAREFAS" }]), "b");
  assert.equal(findReusableTrackerId([{ id: "a", title: "tarefas" }]), "a");
  assert.equal(findReusableTrackerId([{ id: "a", title: "Tarefas do João" }]), null); // não-exata não reusa
  assert.equal(findReusableTrackerId([]), null);
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
});

test("extractNotionPageId: URL notion.so com slug → id de 32 hex", () => {
  assert.equal(
    extractNotionPageId("https://www.notion.so/Minha-Pagina-0123456789abcdef0123456789abcdef?pvs=4"),
    "0123456789abcdef0123456789abcdef",
  );
});

test("extractNotionPageId: UUID com hífens → id compacto", () => {
  assert.equal(
    extractNotionPageId("01234567-89ab-cdef-0123-456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
});

test("extractNotionPageId: nome de página → null (vai para busca)", () => {
  assert.equal(extractNotionPageId("Projetos 2026"), null);
});

test("TARGET_PROPERTIES é o template 003-tasks-v1 (sem Frente)", () => {
  for (const k of [
    "Nome",
    "Status",
    "Prioridade",
    "Prazo",
    "Tempo estimado (min)",
    "Tipo",
    "Quem",
    "Origem",
    "Projeto",
    "Criada em",
    "Concluída em",
  ]) {
    assert.ok(k in TARGET_PROPERTIES, `falta ${k}`);
  }
  assert.ok(!("Frente" in TARGET_PROPERTIES), "Frente saiu do template novo");
  assert.ok(TARGET_PROPERTIES["Nome"].title !== undefined);
  assert.deepEqual(
    TARGET_PROPERTIES["Status"].select.options.map((o: any) => o.name),
    ["Backlog", "A fazer", "Em andamento", "Bloqueada", "Concluída", "Cancelada"],
  );
  assert.deepEqual(
    TARGET_PROPERTIES["Prioridade"].select.options.map((o: any) => o.name),
    ["Urgente", "Alta", "Média", "Baixa"],
  );
  assert.deepEqual(
    TARGET_PROPERTIES["Tipo"].select.options.map((o: any) => o.name),
    ["Fazer", "Cobrar"],
  );
  assert.ok(TARGET_PROPERTIES["Origem"].url !== undefined);
  assert.ok(TARGET_PROPERTIES["Quem"].rich_text !== undefined);
  assert.ok(TARGET_PROPERTIES["Criada em"].created_time !== undefined);
  assert.ok(TARGET_PROPERTIES["Concluída em"].date !== undefined);
  assert.deepEqual(TARGET_PROPERTIES["Projeto"].select.options, []);
});
