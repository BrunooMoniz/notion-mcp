// setup-tasks-flow-destino — Épico 3 (tools MCP) do plano
// 2026-06-12-tasks-onboarding-escolha-destino: conta com mais de um Notion
// conectado precisa ESCOLHER o workspace antes do Zinom criar a base de
// Tarefas. Núcleo puro, deps fake, sem rede/DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTasksFlow, type SetupTasksDeps } from "../../zinom-tasks-tools.js";

function deps(over: Partial<SetupTasksDeps> = {}): SetupTasksDeps {
  return {
    getTasksDbId: async () => null,
    createTaskTracker: async () => ({ dataSourceId: "ds-1", created: true }),
    searchParentPages: async () => [],
    findWorkspaceForPage: async () => null,
    getTasksInfo: async () => ({ title: "Tarefas", url: "https://notion.so/x" }),
    invalidateTrackerProfile: () => {},
    extractNotionPageId: () => null,
    listWorkspaces: async () => ["personal", "globalcripto"],
    ...over,
  };
}

test("sem pagina e sem workspace com 2 workspaces → workspace_required", async () => {
  const out = await setupTasksFlow("acc", {}, deps());
  assert.equal(out.ok, false);
  assert.equal(out.error, "workspace_required");
  assert.deepEqual(out.workspaces, ["personal", "globalcripto"]);
});

test("1 workspace só → cria sem perguntar", async () => {
  const out = await setupTasksFlow("acc", {}, deps({ listWorkspaces: async () => ["personal"] }));
  assert.equal(out.ok, true);
});

test("workspace explícito → cria nele", async () => {
  let usado: string | undefined;
  const out = await setupTasksFlow("acc", { workspace: "globalcripto" }, deps({
    createTaskTracker: async (_a, o) => { usado = o.workspace; return { dataSourceId: "ds-2", created: true }; },
  }));
  assert.equal(out.ok, true);
  assert.equal(usado, "globalcripto");
});
