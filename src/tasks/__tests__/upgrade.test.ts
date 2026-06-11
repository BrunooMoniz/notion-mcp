// src/tasks/__tests__/upgrade.test.ts
// 003-tasks-v1 — diff aditivo do template + a guarda "só o tracker 'Tarefas'".
// O PATCH usa a chave `properties` (Notion 2025-09-03, update-a-data-source) e
// NUNCA envia null (nada é removido/renomeado).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildUpgradeDiff, upgradeStandardTracker, NotStandardTrackerError } from "../upgrade.js";
import { __clearTrackerProfileCache } from "../adapter.js";
import { TARGET_PROPERTIES } from "../../portal/task-tracker-schema.js";
import {
  SCHEMA_STANDARD_NEW,
  SCHEMA_STANDARD_OLD,
  SCHEMA_OWNER,
  fakeFetch,
} from "./fixtures.js";

beforeEach(() => __clearTrackerProfileCache());

// --- buildUpgradeDiff (pure) -----------------------------------------------------

test("diff: template novo já em dia → nada a fazer", () => {
  const { properties, added } = buildUpgradeDiff(SCHEMA_STANDARD_NEW.properties as any);
  assert.deepEqual(properties, {});
  assert.deepEqual(added, []);
});

test("diff: padrão antigo → adiciona campos novos, funde opções de Status, sem duplicar tempo/projeto", () => {
  const { properties, added } = buildUpgradeDiff(SCHEMA_STANDARD_OLD.properties as any);

  // Campos novos adicionados com a definição do template
  for (const k of ["Prioridade", "Tipo", "Quem", "Origem", "Criada em", "Concluída em"]) {
    assert.ok(k in properties, `deveria adicionar ${k}`);
    assert.deepEqual(properties[k], TARGET_PROPERTIES[k]);
  }
  // NÃO duplica: "Tempo estimado" já cobre tempo; "Frente" já cobre projeto
  assert.ok(!("Tempo estimado (min)" in properties), "não duplicar estimativa");
  assert.ok(!("Projeto" in properties), "Frente cobre projeto");

  // Status select: opções existentes preservadas COM id + novas por nome
  const status = (properties as any)["Status"].select.options;
  assert.deepEqual(status.slice(0, 3), [
    { id: "o1", name: "A fazer", color: "default" },
    { id: "o2", name: "Fazendo", color: "blue" },
    { id: "o3", name: "Feito", color: "green" },
  ]);
  assert.deepEqual(
    status.slice(3).map((o: any) => o.name),
    ["Backlog", "Em andamento", "Bloqueada", "Concluída", "Cancelada"],
  );
  assert.ok(added.some((a) => a.startsWith("Status (opções:")));

  // ADITIVO: nunca null (remoção) em nenhum valor
  for (const v of Object.values(properties)) assert.notEqual(v, null);
});

test("diff: schema do owner → status-type fica intocado; só campos realmente faltantes", () => {
  const { properties } = buildUpgradeDiff(SCHEMA_OWNER.properties as any);
  assert.ok(!("Status" in properties), "status-type não é editável via API");
  assert.ok(!("Prioridade" in properties), "Priority cobre prioridade");
  assert.ok(!("Prazo" in properties), "Due date cobre prazo");
  assert.ok(!("Tempo estimado (min)" in properties), "Tempo estimado cobre tempo");
  assert.ok(!("Projeto" in properties), "Projeto já existe (multi_select)");
  for (const k of ["Tipo", "Quem", "Origem", "Criada em", "Concluída em"]) {
    assert.ok(k in properties, `deveria adicionar ${k}`);
  }
});

// --- upgradeStandardTracker (rede falsa) ----------------------------------------------

function upgradeDeps(schema: any) {
  const patches: any[] = [];
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: schema };
      if (init?.method === "PATCH" && url.includes("/v1/data_sources/")) {
        patches.push(JSON.parse(init.body));
        return { body: schema };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => schema.id,
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  return { deps, patches };
}

test("upgradeStandardTracker: SÓ tracker de título 'Tarefas' — outro título recusa sem PATCH", async () => {
  const { deps, patches } = upgradeDeps(SCHEMA_OWNER); // título "Tasks Tracker"
  await assert.rejects(upgradeStandardTracker("friend:up1", deps), NotStandardTrackerError);
  assert.equal(patches.length, 0, "nenhum PATCH pode acontecer");
});

test("upgradeStandardTracker: padrão antigo → PATCH /v1/data_sources com {properties} e retorna added", async () => {
  const { deps, patches } = upgradeDeps(SCHEMA_STANDARD_OLD);
  const r = await upgradeStandardTracker("friend:up2", deps);
  assert.equal(r.ok, true);
  assert.ok(r.added.includes("Prioridade"));
  assert.equal(patches.length, 1);
  // corpo do PATCH: chave `properties` (2025-09-03), nunca `schema`
  assert.ok(patches[0].properties, "body.properties presente");
  assert.equal(patches[0].schema, undefined);
  assert.ok(patches[0].properties["Quem"]);
});

test("upgradeStandardTracker: template já em dia → {ok, added: []} sem PATCH", async () => {
  const { deps, patches } = upgradeDeps(SCHEMA_STANDARD_NEW);
  const r = await upgradeStandardTracker("friend:up3", deps);
  assert.deepEqual(r, { ok: true, added: [] });
  assert.equal(patches.length, 0);
});
