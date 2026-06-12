// src/portal/__tests__/task-tracker-destino.test.ts
// 2026-06-12 tasks-onboarding-escolha-destino — escolha explícita de workspace:
// fingerprint do template Zinom (reuse-guard seguro) e WorkspaceRequiredError
// quando a conta tem mais de um Notion conectado.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isZinomStandardSchema } from "../task-tracker-schema.js";

test("isZinomStandardSchema: template Zinom (Tipo Fazer/Cobrar + Tempo estimado (min)) → true", () => {
  assert.equal(isZinomStandardSchema({
    "Tempo estimado (min)": { type: "number" },
    Tipo: { type: "select", select: { options: [{ name: "Fazer" }, { name: "Cobrar" }] } },
  } as any), true);
});

test("isZinomStandardSchema: board scrum alheio chamado 'Tarefas' → false", () => {
  assert.equal(isZinomStandardSchema({
    "Story Points": { type: "number" },
    Tipo: { type: "select", select: { options: [{ name: "📁 Projetos" }, { name: "☑️ Tarefas" }] } },
  } as any), false);
});
