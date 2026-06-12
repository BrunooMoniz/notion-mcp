// src/rag/__tests__/brain-index-url-tool.test.ts
// Frente B (#97) — brain_index_url multi-tenant. O schema do parâmetro
// `workspace` é gerado POR SESSÃO: o operador mantém o enum fixo dos seus 3
// workspaces; uma conta friend recebe um enum só com os workspaces DELA
// (UUIDs de account_workspaces) com os nomes amigáveis na description, sem
// vazar os nomes dos workspaces privados do operador. Conta sem Notion
// conectado recebe erro claro em runtime. TDD: red antes da implementação.
import { test } from "node:test";
import assert from "node:assert/strict";

// clients.ts valida estes envs no import (process.exit sem eles). Stub antes do
// import dinâmico do módulo sob teste — nenhuma chamada real ao Notion é feita.
process.env.NOTION_GLOBALCRIPTO_TOKEN ??= "ntn_test_stub";
process.env.NOTION_PERSONAL_TOKEN ??= "ntn_test_stub";
process.env.NOTION_NORA_TOKEN ??= "ntn_test_stub";
process.env.OAUTH_PASSWORD_HASH ??= "stub-hash";

const { registerBrainIndexUrlTool, buildFriendWorkspaceParam } = await import(
  "../brain-index-url-tool.js"
);
const { requestContext } = await import("../../context.js");

// ---------- helpers ---------------------------------------------------------

const WS_GC = "313d872b-aaaa-bbbb-cccc-0123456789ab";
const WS_SEM_NOME = "9f00aaaa-1111-2222-3333-444455556666";

function fakeServer() {
  const tools = new Map<
    string,
    { description: string; schema: Record<string, any>; handler: (args: any) => Promise<any> }
  >();
  const server = {
    tool: (name: string, description: string, schema: Record<string, any>, handler: any) =>
      tools.set(name, { description, schema, handler }),
  } as any;
  return { server, tools };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    isOwner: () => false,
    getAccountId: () => "acct-amigo",
    listWorkspaces: async (_accountId: string) => [
      { workspace: WS_GC, name: "Global Cripto" },
      { workspace: WS_SEM_NOME, name: null },
    ],
    ...overrides,
  } as any;
}

function toolPayload(res: any): any {
  return JSON.parse(res.content[0].text);
}

// ---------- buildFriendWorkspaceParam (puro) ---------------------------------

test("buildFriendWorkspaceParam: enum aceita só os UUIDs da conta", () => {
  const param = buildFriendWorkspaceParam([
    { workspace: WS_GC, name: "Global Cripto" },
    { workspace: WS_SEM_NOME, name: null },
  ]);
  assert.equal(param.hasWorkspaces, true);
  assert.equal(param.schema.safeParse(WS_GC).success, true);
  assert.equal(param.schema.safeParse(WS_SEM_NOME).success, true);
  // Os workspaces do operador NUNCA passam para uma conta friend.
  for (const ws of ["personal", "globalcripto", "nora"]) {
    assert.equal(param.schema.safeParse(ws).success, false, `não deveria aceitar "${ws}"`);
  }
});

test("buildFriendWorkspaceParam: description traz UUID = nome amigável", () => {
  const param = buildFriendWorkspaceParam([{ workspace: WS_GC, name: "Global Cripto" }]);
  const desc = param.schema.description ?? "";
  assert.ok(desc.includes(WS_GC), "description deveria conter o UUID");
  assert.ok(desc.includes("Global Cripto"), "description deveria conter o nome amigável");
});

test("buildFriendWorkspaceParam: workspace sem nome aparece só pelo UUID", () => {
  const param = buildFriendWorkspaceParam([{ workspace: WS_SEM_NOME, name: null }]);
  const desc = param.schema.description ?? "";
  assert.ok(desc.includes(WS_SEM_NOME));
  assert.ok(!desc.includes("null"), "não deveria imprimir 'null' como nome");
});

test("buildFriendWorkspaceParam: conta sem workspace -> hasWorkspaces=false", () => {
  const param = buildFriendWorkspaceParam([]);
  assert.equal(param.hasWorkspaces, false);
  // O schema não pode travar a chamada antes do erro claro em runtime.
  assert.equal(param.schema.safeParse(undefined).success, true);
});

// ---------- registro por sessão ----------------------------------------------

test("operador: mantém o enum fixo dos 3 workspaces e não consulta o banco", async () => {
  const { server, tools } = fakeServer();
  let listCalls = 0;
  await registerBrainIndexUrlTool(
    server,
    makeDeps({
      isOwner: () => true,
      listWorkspaces: async () => {
        listCalls++;
        return [];
      },
    }),
  );
  const t = tools.get("brain_index_url");
  assert.ok(t, "tool não registrada");
  assert.equal(listCalls, 0, "operador não deve disparar lookup de account_workspaces");
  for (const ws of ["personal", "globalcripto", "nora"]) {
    assert.equal(t!.schema.workspace.safeParse(ws).success, true, `deveria aceitar "${ws}"`);
  }
  assert.equal(t!.schema.workspace.safeParse(WS_GC).success, false);
});

test("friend: schema da sessão expõe só os workspaces DA CONTA", async () => {
  const { server, tools } = fakeServer();
  const seen: string[] = [];
  await registerBrainIndexUrlTool(
    server,
    makeDeps({
      listWorkspaces: async (accountId: string) => {
        seen.push(accountId);
        return [{ workspace: WS_GC, name: "Global Cripto" }];
      },
    }),
  );
  assert.deepEqual(seen, ["acct-amigo"], "deve buscar workspaces do accountId da sessão");
  const t = tools.get("brain_index_url")!;
  assert.equal(t.schema.workspace.safeParse(WS_GC).success, true);
  for (const ws of ["personal", "globalcripto", "nora"]) {
    assert.equal(t.schema.workspace.safeParse(ws).success, false, `vazou "${ws}"`);
  }
});

test("friend: nada na tool vaza os nomes dos workspaces do operador", async () => {
  const { server, tools } = fakeServer();
  await registerBrainIndexUrlTool(server, makeDeps());
  const t = tools.get("brain_index_url")!;
  const surface = `${t.description} ${t.schema.workspace.description ?? ""}`;
  for (const leak of ["personal", "globalcripto", "nora", "Bruno"]) {
    assert.ok(!surface.includes(leak), `superfície da tool vazou "${leak}"`);
  }
  assert.ok(surface.includes("Global Cripto"), "deveria citar o nome amigável da conta");
});

test("friend sem Notion: handler responde erro claro pedindo conexão no portal", async () => {
  const { server, tools } = fakeServer();
  await registerBrainIndexUrlTool(server, makeDeps({ listWorkspaces: async () => [] }));
  const t = tools.get("brain_index_url")!;
  const payload = toolPayload(
    await t.handler({ url: "https://www.notion.so/Pagina-0123456789abcdef0123456789abcdef", max_pages: 5 }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "no_notion_workspace");
  assert.match(payload.message, /conecte um Notion no portal/i);
});

test("handler mantém o gate assertWorkspaceScope no write", async () => {
  const { server, tools } = fakeServer();
  await registerBrainIndexUrlTool(
    server,
    makeDeps({ listWorkspaces: async () => [{ workspace: WS_GC, name: "Global Cripto" }] }),
  );
  const t = tools.get("brain_index_url")!;
  // Token escopado para OUTRO workspace: o write tem que ser negado mesmo que
  // o valor passe no enum da sessão (defesa em profundidade).
  await assert.rejects(
    () =>
      requestContext.run(
        { authType: "bearer", scopes: ["outro-workspace"] as any, accountId: "acct-amigo" },
        () =>
          t.handler({
            workspace: WS_GC,
            url: "https://www.notion.so/Pagina-0123456789abcdef0123456789abcdef",
            max_pages: 1,
          }),
      ),
    /Access denied/,
  );
});
