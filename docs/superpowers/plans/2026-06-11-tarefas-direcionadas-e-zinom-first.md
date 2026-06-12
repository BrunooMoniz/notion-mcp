# Tarefas direcionadas (página/workspace) + Zinom-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O usuário aponta em qual página e workspace do Notion a base de Tarefas (Kanban) é criada, recebe o link clicável do board em todas as superfícies, e os clientes MCP passam a preferir o Zinom para tarefas/calendário em vez de integrações nativas.

**Architecture:** Estende `createTaskTracker` com alvo explícito (`workspace` + `parentPageId`), expõe isso por uma nova MCP tool `zinom_setup_tasks` (com núcleo puro injetável `setupTasksFlow`) e pelo portal (param no `POST /portal/tasks/create` + picker `GET /portal/tasks/pages`). As instruções do servidor ganham a seção "Zinom primeiro" (owner + friend) e o `INSTRUCTIONS` do owner migra de `index.ts` para `mcp-account-config.ts` (módulo puro) para ser testável.

**Tech Stack:** TypeScript/Express, MCP SDK (`server.tool`), Notion API 2025-09-03 via fetch cru, testes `node:test` via `npm test` (tsx), Playwright e2e no portal.

**Critério de aceite (verificado por máquina):**
1. `npm run build` e `npm test` verdes localmente e CI `build-test` verde no PR.
2. Testes novos provam: criação sob `parentPageId` sem página-mãe e sem reuse-guard; `workspace` respeitado (token certo); contrato de `zinom_setup_tasks` (already_configured / ambiguous / not_found / sucesso com tracker_url); `tracker_url` nas respostas de create/list/plan; instructions (owner e friend) contêm "Zinom primeiro para tarefas e calendário".
3. Pós-deploy: `/health` 200, `/status` sem stale, `https://zinom.ai/mcp` responde 401, e `tools/list` no MCP da VPS contém `zinom_setup_tasks`.

**Riscos declarados:**
- `resolveAccountNotion` passa a resolver tokens .env para o owner (antes retornava null). Efeito: `createTaskTracker`/`zinom_setup_tasks` passam a funcionar para o owner. O fallback `OWNER_TASKS_DS_FALLBACK` do adapter continua valendo.
- Com `parentPageId` explícito o reuse-guard é PULADO de propósito (a pessoa disse onde quer). Documentado no código.
- A API do Notion não cria views (kanban) — o board nasce como tabela com a coluna Status; a mensagem do tool orienta a trocar a view no Notion.

---

## Convenções (valem para todas as tasks)

- Worktrees: criados pelo orquestrador em `zinom-engine/.claude/worktrees/<nome>`. Rodar `npm ci` no worktree antes de testar.
- Rodar testes: `npm test` (suite toda) e pontualmente `node --import tsx --test src/<path>/__tests__/<file>.test.ts`.
- Commits pequenos por step, mensagem `feat:`/`test:`/`refactor:` clara.
- Não tocar em arquivos fora dos listados na própria task.

---

### Task 1: Núcleo — `createTaskTracker` com alvo explícito (worktree `core-targeting`, branch `feat/tasks-targeting-core`)

**Files:**
- Modify: `src/portal/task-tracker-schema.ts` (novo helper puro `extractNotionPageId`)
- Modify: `src/portal/task-tracker.ts` (assinatura nova + `listAccountNotionTokens` + `searchParentPages` + `findWorkspaceForPage`)
- Test: `src/portal/__tests__/task-tracker-schema.test.ts`
- Test: `src/portal/__tests__/task-tracker.test.ts`

- [ ] **Step 1: testes que falham — `extractNotionPageId`** (em `task-tracker-schema.test.ts`, seguindo o estilo do arquivo):

```ts
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
```

- [ ] **Step 2: rodar e ver falhar** — `node --import tsx --test src/portal/__tests__/task-tracker-schema.test.ts` → FAIL (função não existe).

- [ ] **Step 3: implementar em `task-tracker-schema.ts`** (módulo puro, sem rede):

```ts
/** Extrai o id de página de uma URL notion.so ou de um id cru (32-hex, com ou sem
 *  hífens). null quando o texto não contém id no fim — é um NOME para busca. */
export function extractNotionPageId(input: string): string | null {
  const s = (input ?? "").trim();
  const tail = /notion\.(so|site)/i.test(s) ? (s.split("?")[0].split("/").pop() ?? "") : s;
  const m = tail.replace(/-/g, "").match(/([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : null;
}
```

- [ ] **Step 4: rodar e ver passar.** Commit: `feat(tasks): extractNotionPageId puro p/ alvo de criação`.

- [ ] **Step 5: testes que falham — task-tracker** (em `task-tracker.test.ts`, usando o `memPool`/`seedNotion`/`routeFetch` que JÁ existem no arquivo; `routeFetch` recebe `(url, init)` e `init.headers.Authorization` está disponível):

```ts
test("create: parentPageId explícito → DB sob a página, sem 🧠 Zinom e sem reuse-guard", async () => {
  await seedNotion("friend:x");
  const calls: Array<{ url: string; body: any }> = [];
  const r = await createTaskTracker("friend:x", {
    parentPageId: "0123456789abcdef0123456789abcdef",
    fetchImpl: routeFetch((url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/v1/databases")) return { id: "db-1", data_sources: [{ id: "ds-1" }] };
      return {};
    }),
  });
  assert.equal(r.dataSourceId, "ds-1");
  assert.equal(r.created, true);
  assert.ok(!calls.some((c) => c.url.includes("/v1/search")), "sem reuse-guard com alvo explícito");
  assert.ok(!calls.some((c) => c.url.includes("/v1/pages")), "sem página-mãe com alvo explícito");
  const db = calls.find((c) => c.url.includes("/v1/databases"));
  assert.equal(db!.body.parent.page_id, "0123456789abcdef0123456789abcdef");
  assert.equal(await getTasksDbId("friend:x"), "ds-1");
});

test("create: workspace preferido usa o token DESSE workspace", async () => {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret("friend:x", "notion_pat:ws-1", "ntn_um");
  await setAccountSecret("friend:x", "notion_pat:ws-2", "ntn_dois");
  workspaces = ["ws-1", "ws-2"];
  let auth = "";
  await createTaskTracker("friend:x", {
    workspace: "ws-2",
    parentPageId: "0123456789abcdef0123456789abcdef",
    fetchImpl: routeFetch((url, init) => {
      if (String(url).includes("/v1/databases")) {
        auth = init?.headers?.Authorization ?? "";
        return { id: "db-1", data_sources: [{ id: "ds-2" }] };
      }
      return {};
    }),
  });
  assert.equal(auth, "Bearer ntn_dois");
});

test("create: workspace preferido sem token → erro claro", async () => {
  await seedNotion("friend:x"); // só ws-1
  await assert.rejects(
    () => createTaskTracker("friend:x", { workspace: "ws-9", fetchImpl: routeFetch(() => ({})) }),
    /ws-9/,
  );
});

test("searchParentPages: agrega páginas por workspace com título e url", async () => {
  await seedNotion("friend:x");
  const pages = await searchParentPages("friend:x", "Projetos", {
    fetchImpl: routeFetch((url) => {
      if (String(url).includes("/v1/search")) {
        return { results: [{ id: "p-1", url: "https://notion.so/p1", properties: { Nome: { type: "title", title: [{ plain_text: "Projetos 2026" }] } } }] };
      }
      return {};
    }),
  });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], { id: "p-1", title: "Projetos 2026", url: "https://notion.so/p1", workspace: "ws-1" });
});

test("findWorkspaceForPage: primeiro token que lê a página ganha", async () => {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret("friend:x", "notion_pat:ws-1", "ntn_um");
  await setAccountSecret("friend:x", "notion_pat:ws-2", "ntn_dois");
  workspaces = ["ws-1", "ws-2"];
  const hit = await findWorkspaceForPage("friend:x", "0123456789abcdef0123456789abcdef", {
    fetchImpl: (async (url: string, init: any) => {
      const okToken = init?.headers?.Authorization === "Bearer ntn_dois";
      return {
        ok: okToken, status: okToken ? 200 : 404,
        text: async () => JSON.stringify(okToken
          ? { id: "0123...", url: "https://notion.so/x", properties: { title: { type: "title", title: [{ plain_text: "Casa" }] } } }
          : { code: "object_not_found" }),
      };
    }) as any,
  });
  assert.equal(hit?.workspace, "ws-2");
  assert.equal(hit?.title, "Casa");
});

test("owner: resolve tokens do .env (DEFAULT_ACCOUNT_ID)", async () => {
  process.env.NOTION_PERSONAL_TOKEN = "ntn_env_personal";
  try {
    let auth = "";
    await createTaskTracker("bruno", {
      workspace: "personal",
      parentPageId: "0123456789abcdef0123456789abcdef",
      fetchImpl: routeFetch((url, init) => {
        if (String(url).includes("/v1/databases")) {
          auth = init?.headers?.Authorization ?? "";
          return { id: "db-1", data_sources: [{ id: "ds-o" }] };
        }
        return {};
      }),
    });
    assert.equal(auth, "Bearer ntn_env_personal");
  } finally { delete process.env.NOTION_PERSONAL_TOKEN; }
});
```

- [ ] **Step 6: rodar e ver falhar** — `node --import tsx --test src/portal/__tests__/task-tracker.test.ts`.

- [ ] **Step 7: implementar em `task-tracker.ts`:**

```ts
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { extractNotionPageId /* já importado? adicionar */ } from "./task-tracker-schema.js"; // só se precisar

function ownerEnvTokens(): Array<{ workspace: string; token: string }> {
  const pairs: Array<[string, string | undefined]> = [
    ["personal", process.env.NOTION_PERSONAL_TOKEN],
    ["globalcripto", process.env.NOTION_GLOBALCRIPTO_TOKEN],
    ["nora", process.env.NOTION_NORA_TOKEN],
  ];
  return pairs.filter(([, t]) => !!t).map(([workspace, token]) => ({ workspace, token: token! }));
}

/** Todos os pares workspace+token Notion da conta (owner = .env; friend = vault). */
export async function listAccountNotionTokens(
  accountId: string,
): Promise<Array<{ workspace: string; token: string }>> {
  if (accountId === DEFAULT_ACCOUNT_ID) return ownerEnvTokens();
  const workspaces = await warmAccount(accountId);
  const out: Array<{ workspace: string; token: string }> = [];
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (token) out.push({ workspace: ws, token });
  }
  return out;
}

/** Token + workspace da conta. Sem `preferred`: o primeiro com token (comportamento
 *  histórico). Com `preferred`: SÓ esse workspace; sem token nele → erro nominal. */
async function resolveAccountNotion(
  accountId: string,
  preferred?: string,
): Promise<{ token: string; workspace: string } | null> {
  const all = await listAccountNotionTokens(accountId);
  if (preferred) {
    const hit = all.find((t) => t.workspace === preferred);
    if (!hit) throw new Error(`sem Notion conectado no workspace "${preferred}"`);
    return hit;
  }
  return all[0] ?? null;
}
```

Assinatura nova de `createTaskTracker` (substitui a atual; o fluxo sem `parentPageId` fica IGUAL ao existente):

```ts
export interface CreateTrackerOptions {
  fetchImpl?: typeof fetch;
  /** owner: personal|globalcripto|nora; friend: workspace id do vault. */
  workspace?: string;
  /** Página existente (id 32-hex) onde criar a DB. Pula reuse-guard e página-mãe. */
  parentPageId?: string;
}

export async function createTaskTracker(
  accountId: string,
  opts: CreateTrackerOptions = {},
): Promise<{ dataSourceId: string; created: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId, opts.workspace);
  if (!conn) throw new Error("conecte o Notion antes de criar as Tarefas");

  if (opts.parentPageId) {
    // Alvo explícito: a pessoa disse ONDE quer — sem reuse-guard e sem "🧠 Zinom".
    const db = await notionFetch(
      conn.token,
      "/v1/databases",
      { method: "POST", body: JSON.stringify(buildCreateDbPayload(opts.parentPageId)) },
      fetchImpl,
    );
    const dataSourceId: string = db?.data_sources?.[0]?.id ?? db?.id;
    if (!dataSourceId) throw new Error("Notion não retornou o id da base criada");
    await setTasksDbId(accountId, dataSourceId);
    await invalidateProfileSafe(accountId);
    return { dataSourceId, created: true };
  }
  // ... (fluxo atual: reuse-guard + página 🧠 Zinom + DB; usar invalidateProfileSafe
  //      no lugar do try/catch inline de invalidate)
}

async function invalidateProfileSafe(accountId: string): Promise<void> {
  try {
    const { invalidateTrackerProfile } = await import("../tasks/adapter.js");
    invalidateTrackerProfile(accountId);
  } catch (err: any) {
    console.warn(`[task-tracker] ${accountId}: invalidate failed: ${err?.message ?? err}`);
  }
}
```

Novos helpers exportados (mesmo arquivo):

```ts
export interface ParentPageCandidate { id: string; title: string; url: string | null; workspace: string }

function pageTitleOf(page: any): string {
  for (const v of Object.values(page?.properties ?? {})) {
    if ((v as any)?.type === "title") return plainTitle((v as any).title);
  }
  return plainTitle(page?.title);
}

/** Busca páginas candidatas a "casa" da base, em todos os Notion conectados. */
export async function searchParentPages(
  accountId: string,
  query: string,
  opts: { fetchImpl?: typeof fetch; workspace?: string } = {},
): Promise<ParentPageCandidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let tokens = await listAccountNotionTokens(accountId);
  if (opts.workspace) tokens = tokens.filter((t) => t.workspace === opts.workspace);
  const out: ParentPageCandidate[] = [];
  for (const { workspace, token } of tokens) {
    try {
      const r = await notionFetch(
        token,
        "/v1/search",
        { method: "POST", body: JSON.stringify({ query, filter: { property: "object", value: "page" }, page_size: 10 }) },
        fetchImpl,
      );
      for (const p of r.results ?? []) {
        if (!p?.id) continue;
        out.push({ id: p.id, title: pageTitleOf(p) || "(sem título)", url: p.url ?? null, workspace });
      }
    } catch (err: any) {
      console.warn(`[task-tracker] ${accountId}: search pages ${workspace}: ${err?.message ?? err}`);
    }
  }
  return out;
}

/** Em qual workspace conectado a página é legível (primeiro token que lê ganha). */
export async function findWorkspaceForPage(
  accountId: string,
  pageId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ workspace: string; title: string; url: string | null } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const { workspace, token } of await listAccountNotionTokens(accountId)) {
    try {
      const p = await notionFetch(token, `/v1/pages/${pageId}`, { method: "GET" }, fetchImpl);
      if (p?.id) return { workspace, title: pageTitleOf(p) || "(sem título)", url: p.url ?? null };
    } catch {
      /* este token não lê a página — tenta o próximo */
    }
  }
  return null;
}
```

- [ ] **Step 8: rodar a suite do arquivo e depois `npm test` inteiro.** Os testes antigos de `createTaskTracker` (sem opts) DEVEM continuar passando sem alteração.
- [ ] **Step 9: Commit** `feat(tasks): createTaskTracker com workspace+página alvo; busca de páginas; tokens do owner via env`.

---

### Task 2: Instructions "Zinom primeiro" (worktree `zinom-first`, branch `feat/zinom-first-instructions`)

**Files:**
- Modify: `src/index.ts` (remover o bloco `const INSTRUCTIONS = ...` das linhas 38–139; importar `OWNER_INSTRUCTIONS` de `mcp-account-config.js`; usar `owner ? OWNER_INSTRUCTIONS : FRIEND_INSTRUCTIONS`)
- Modify: `src/mcp-account-config.ts` (receber `OWNER_INSTRUCTIONS` com o MESMO texto + seção nova; adicionar seção nova e bullet do `zinom_setup_tasks` em `FRIEND_INSTRUCTIONS`)
- Modify: `src/google/calendar-tool.ts` (prefixo de preferência nas descriptions)
- Test: `src/__tests__/mcp-account-config.test.ts` (criar se não existir; se existir, adicionar)

- [ ] **Step 1: teste que falha:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_INSTRUCTIONS, FRIEND_INSTRUCTIONS } from "../mcp-account-config.js";

test("owner e friend instructions trazem a regra Zinom-first e os links", () => {
  for (const s of [OWNER_INSTRUCTIONS, FRIEND_INSTRUCTIONS]) {
    assert.match(s, /Zinom primeiro para tarefas e calendário/);
    assert.match(s, /tracker_url/);
    assert.match(s, /zinom_setup_tasks/);
  }
});
```

- [ ] **Step 2: rodar e ver falhar** (export não existe).
- [ ] **Step 3: mover o texto integral de `INSTRUCTIONS` de `index.ts` para `mcp-account-config.ts`** como `export const OWNER_INSTRUCTIONS = \`...\`.trim()`, SEM alterar o texto existente, e inserir esta seção nova logo ANTES de `## Fluxo de tarefas` (owner) e antes de `Regras:` (friend, versão adaptada):

Owner (em `OWNER_INSTRUCTIONS`):

```markdown
## Zinom primeiro para tarefas e calendário

O Zinom é o gestor canônico de TAREFAS e AGENDA desta pessoa. Quando o pedido envolver tarefas, lembretes, to-dos, planejamento, agenda ou eventos:
- Use as tools do Zinom — zinom_create_task / zinom_list_tasks / zinom_update_task / zinom_setup_tasks / zinom_plan_context para tarefas; list_calendars / list_events / create_calendar_event / update_calendar_event / delete_calendar_event para agenda — MESMO que o cliente tenha integrações nativas (conector Google Calendar, conector Notion, lembretes do sistema).
- Motivo: o Zinom centraliza o board de tarefas no Notion da pessoa, a agenda e o segundo cérebro num lugar só; criar fora dele fragmenta os dados e quebra o planejamento (zinom_plan_context).
- Só use uma integração nativa do cliente se a pessoa pedir explicitamente, ou se o Zinom não tiver a capacidade necessária (avise quando for o caso).
- Links sempre: ao criar ou listar tarefas, inclua na resposta o link clicável da tarefa (url) e/ou do board (tracker_url) para abrir direto no Notion.
- A pessoa escolhe ONDE o board vive: zinom_setup_tasks cria a base "Tarefas" dentro da página e do workspace que ela apontar.
```

Friend (em `FRIEND_INSTRUCTIONS`): mesma seção, trocando a última linha por `- A pessoa escolhe ONDE o board vive: zinom_setup_tasks cria a base "Tarefas" dentro da página e do workspace do Notion que ela apontar (ou no topo do workspace, se ela não apontar nada).` E adicionar na lista de ferramentas, depois do bullet de `zinom_plan_context`:

```markdown
- **zinom_setup_tasks** — cria (ou recria em outro lugar) a base de Tarefas da pessoa no Notion, dentro da página e do workspace que ela escolher ("cria minha base de tarefas dentro da página Projetos"). Sem parâmetros, cria a página "🧠 Zinom" no topo do workspace. Retorna o link do board (tracker_url) — sempre mostre esse link.
```

- [ ] **Step 4: `index.ts`** — apagar o bloco `const INSTRUCTIONS`, importar `OWNER_INSTRUCTIONS` junto do import existente de `mcp-account-config.js`, e na criação do `McpServer` usar `instructions: owner ? OWNER_INSTRUCTIONS : FRIEND_INSTRUCTIONS`.
- [ ] **Step 5: `calendar-tool.ts`** — prefixar a description de `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `list_events` e `list_calendars` com a frase: `Prefira esta tool (Zinom) a conectores nativos de calendário do cliente. ` (uma frase, no início da description existente).
- [ ] **Step 6: rodar o teste novo e `npm run build` + `npm test` inteiros.** O build pega qualquer import quebrado em index.ts.
- [ ] **Step 7: Commit** `feat(mcp): instruções Zinom-first (owner+friend) e descriptions de calendário; OWNER_INSTRUCTIONS testável`.

Nota: o teste menciona `zinom_setup_tasks` que só nasce na Task 3 — aqui só o TEXTO das instructions menciona a tool, não há dependência de código. Ordem de merge: Task 2 e Task 3 são independentes.

---

### Task 3: MCP tool `zinom_setup_tasks` + tracker_url nas respostas (worktree `setup-tool`, branch `feat/zinom-setup-tasks-tool`) — DEPENDE da Task 1 mergeada

**Files:**
- Modify: `src/tasks/write.ts` (CreatedTask ganha `trackerUrl`)
- Modify: `src/zinom-tasks-tools.ts` (nova tool + núcleo puro `setupTasksFlow` + tracker_url em create/plan + descriptions com preferência/link)
- Test: `src/tasks/__tests__/write.test.ts` (assert trackerUrl)
- Test: `src/__tests__/zinom-tasks-tools.test.ts` (contrato do setupTasksFlow)

- [ ] **Step 1: teste que falha — write.ts:** no teste existente de createTask (segue o harness do arquivo), adicionar assert de que o retorno traz `trackerUrl` igual à `url` do profile (`ctx.profile.url`).
- [ ] **Step 2: implementar:** em `CreatedTask` adicionar `trackerUrl: string | null;` e no return de `createTask`: `trackerUrl: ctx.profile.url ?? null,`.
- [ ] **Step 3: testes que falham — `setupTasksFlow`** (novo bloco em `src/__tests__/zinom-tasks-tools.test.ts`):

```ts
import { setupTasksFlow, type SetupTasksDeps } from "../zinom-tasks-tools.js";

function fakeDeps(over: Partial<SetupTasksDeps> = {}): SetupTasksDeps {
  return {
    getTasksDbId: async () => null,
    createTaskTracker: async () => ({ dataSourceId: "ds-1", created: true }),
    searchParentPages: async () => [],
    findWorkspaceForPage: async () => null,
    getTasksInfo: async () => ({ title: "Tarefas", url: "https://notion.so/board" } as any),
    invalidateTrackerProfile: () => {},
    extractNotionPageId: (s: string) => (/^[0-9a-f]{32}$/i.test(s.replace(/-/g, "")) ? s.replace(/-/g, "").toLowerCase() : null),
    ...over,
  };
}

test("setup: já configurada sem confirmar → already_configured com link", async () => {
  const out: any = await setupTasksFlow("a", {}, fakeDeps({ getTasksDbId: async () => "ds-velha" }));
  assert.equal(out.ok, false);
  assert.equal(out.error, "already_configured");
  assert.equal(out.tracker_url, "https://notion.so/board");
});

test("setup: nome com várias páginas → ambiguous_page com candidates", async () => {
  const cands = [
    { id: "p1", title: "Projetos", url: "u1", workspace: "ws-1" },
    { id: "p2", title: "Projetos", url: "u2", workspace: "ws-2" },
  ];
  const out: any = await setupTasksFlow("a", { pagina: "Projetos" }, fakeDeps({ searchParentPages: async () => cands }));
  assert.equal(out.error, "ambiguous_page");
  assert.deepEqual(out.candidates, cands);
});

test("setup: nome não encontrado → page_not_found", async () => {
  const out: any = await setupTasksFlow("a", { pagina: "Nada" }, fakeDeps());
  assert.equal(out.error, "page_not_found");
});

test("setup: URL → extrai id, resolve workspace pela página e cria lá", async () => {
  let got: any = null;
  const out: any = await setupTasksFlow(
    "a",
    { pagina: "https://www.notion.so/Casa-0123456789abcdef0123456789abcdef" },
    fakeDeps({
      findWorkspaceForPage: async () => ({ workspace: "ws-2", title: "Casa", url: "https://notion.so/casa" }),
      createTaskTracker: async (_a, opts) => { got = opts; return { dataSourceId: "ds-1", created: true }; },
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(got.parentPageId, "0123456789abcdef0123456789abcdef");
  assert.equal(got.workspace, "ws-2");
  assert.equal(out.tracker_url, "https://notion.so/board");
  assert.match(out.message, /Casa/);
});

test("setup: URL ilegível por todos os tokens → page_not_accessible", async () => {
  const out: any = await setupTasksFlow(
    "a",
    { pagina: "0123456789abcdef0123456789abcdef" },
    fakeDeps({ findWorkspaceForPage: async () => null }),
  );
  assert.equal(out.error, "page_not_accessible");
});

test("setup: sem pagina → cria padrão (🧠 Zinom) e devolve link", async () => {
  let got: any = "sentinel";
  const out: any = await setupTasksFlow("a", {}, fakeDeps({
    createTaskTracker: async (_a, opts) => { got = opts; return { dataSourceId: "ds-1", created: true }; },
  }));
  assert.equal(out.ok, true);
  assert.equal(got.parentPageId, undefined);
  assert.match(out.message, /🧠 Zinom|topo do workspace/);
});
```

- [ ] **Step 4: implementar `setupTasksFlow` + tool em `zinom-tasks-tools.ts`:**

```ts
export interface SetupTasksDeps {
  getTasksDbId: (accountId: string) => Promise<string | null>;
  createTaskTracker: (
    accountId: string,
    opts: { workspace?: string; parentPageId?: string },
  ) => Promise<{ dataSourceId: string; created: boolean }>;
  searchParentPages: (
    accountId: string,
    q: string,
    opts: { workspace?: string },
  ) => Promise<Array<{ id: string; title: string; url: string | null; workspace: string }>>;
  findWorkspaceForPage: (
    accountId: string,
    pageId: string,
  ) => Promise<{ workspace: string; title: string; url: string | null } | null>;
  getTasksInfo: (accountId: string) => Promise<{ title: string | null; url: string | null }>;
  invalidateTrackerProfile: (accountId: string) => void;
  extractNotionPageId: (s: string) => string | null;
}

export interface SetupTasksArgs { pagina?: string; workspace?: string; confirmar?: boolean }

/** Núcleo puro (deps injetáveis) da zinom_setup_tasks — retorna o objeto JSON da
 *  resposta. Mantido separado do handler para ser testável sem rede/DB. */
export async function setupTasksFlow(
  accountId: string,
  args: SetupTasksArgs,
  deps: SetupTasksDeps,
): Promise<Record<string, unknown>> {
  const existing = await deps.getTasksDbId(accountId);
  if (existing && !args.confirmar) {
    let info: { title: string | null; url: string | null } = { title: null, url: null };
    try { info = await deps.getTasksInfo(accountId); } catch { /* sem link */ }
    return {
      ok: false,
      error: "already_configured",
      title: info.title,
      tracker_url: info.url,
      message:
        "Você já tem uma base de Tarefas configurada" + (info.url ? `: ${info.url}` : ".") +
        " Para criar uma NOVA base em outro lugar e passar a usá-la, chame de novo com confirmar=true" +
        " (a base antiga continua no seu Notion; as tarefas não são migradas automaticamente).",
    };
  }

  let parentPageId: string | undefined;
  let targetWorkspace = args.workspace;
  let parentTitle: string | null = null;

  const pagina = args.pagina?.trim();
  if (pagina) {
    const direct = deps.extractNotionPageId(pagina);
    if (direct) {
      parentPageId = direct;
      if (!targetWorkspace) {
        const hit = await deps.findWorkspaceForPage(accountId, direct);
        if (!hit) {
          return {
            ok: false, error: "page_not_accessible",
            message: "Não consegui ler essa página com nenhum Notion conectado. Confira se a integração do Zinom tem acesso a ela (Share → conexões) e tente de novo.",
          };
        }
        targetWorkspace = hit.workspace;
        parentTitle = hit.title;
      }
    } else {
      const candidates = await deps.searchParentPages(accountId, pagina, { workspace: targetWorkspace });
      if (candidates.length === 0) {
        return {
          ok: false, error: "page_not_found",
          message: `Não achei nenhuma página chamada "${pagina}" nos Notion conectados. Ela existe e a integração tem acesso? Você também pode mandar a URL da página.`,
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false, error: "ambiguous_page", candidates,
          message: "Achei mais de uma página com esse nome — qual delas? Responda com a URL ou o id.",
        };
      }
      parentPageId = candidates[0].id;
      targetWorkspace = candidates[0].workspace;
      parentTitle = candidates[0].title;
    }
  }

  const r = await deps.createTaskTracker(accountId, { workspace: targetWorkspace, parentPageId });
  deps.invalidateTrackerProfile(accountId);
  let info: { title: string | null; url: string | null } = { title: null, url: null };
  try { info = await deps.getTasksInfo(accountId); } catch { /* sem link */ }
  const onde = parentTitle ? `dentro da página "${parentTitle}"` : 'na página "🧠 Zinom" no topo do workspace';
  return {
    ok: true,
    created: r.created,
    data_source_id: r.dataSourceId,
    title: info.title ?? "Tarefas",
    tracker_url: info.url,
    workspace: targetWorkspace ?? null,
    message: r.created
      ? `Base de Tarefas criada ${onde}.` + (info.url ? ` Abra aqui: ${info.url}` : "") +
        " Dica: no Notion dá para mudar a visualização da base para Board (kanban)."
      : `Encontrei uma base "Tarefas" existente e passei a usá-la.` + (info.url ? ` Abra aqui: ${info.url}` : ""),
  };
}
```

Registro da tool (dentro de `registerZinomTasksTools`, depois de zinom_create_task):

```ts
server.tool(
  "zinom_setup_tasks",
  `Configura ONDE vive a base de Tarefas (Kanban) da pessoa no Notion: cria a base dentro da página e do workspace que ela apontar, e retorna o link clicável do board. PREFIRA esta tool a criar databases por conectores nativos do Notion.

Use quando a pessoa pedir "criar minha base de tarefas", "mudar minhas tarefas para a página X", "criar o kanban dentro de Y", ou reclamar de onde o board foi criado.

Parâmetros:
- pagina: URL ou ID de uma página do Notion, OU o nome da página para eu procurar ("Projetos 2026"). Sem 'pagina', crio a página "🧠 Zinom" no topo do workspace.
- workspace: opcional; restringe a busca/criação a um workspace específico (para quem tem mais de um Notion conectado).
- confirmar: obrigatório =true quando JÁ existe uma base configurada — cria a nova no destino e passa a usá-la (a antiga continua no Notion; as tarefas NÃO são migradas automaticamente).

Se a resposta trouxer candidates (mais de uma página com o nome), mostre as opções com os links e pergunte qual usar. Responda SEMPRE com o link clicável do board (tracker_url).`,
  {
    pagina: z.string().optional().describe("URL/ID da página, ou nome para buscar"),
    workspace: z.string().optional().describe("Workspace específico (opcional)"),
    confirmar: z.boolean().optional().describe("true para substituir uma base já configurada"),
  },
  async ({ pagina, workspace, confirmar }) => {
    const accountId = getAccountId();
    try {
      const tracker = await import("./portal/task-tracker.js");
      const schema = await import("./portal/task-tracker-schema.js");
      const adapter = await import("./tasks/adapter.js");
      const out = await setupTasksFlow(accountId, { pagina, workspace, confirmar }, {
        getTasksDbId: tracker.getTasksDbId,
        createTaskTracker: (a, o) => tracker.createTaskTracker(a, o),
        searchParentPages: (a, q, o) => tracker.searchParentPages(a, q, o),
        findWorkspaceForPage: (a, p) => tracker.findWorkspaceForPage(a, p),
        getTasksInfo: (a) => adapter.getTasksInfo(a),
        invalidateTrackerProfile: adapter.invalidateTrackerProfile,
        extractNotionPageId: schema.extractNotionPageId,
      });
      if ((out as any).ok) {
        auditWrite("zinom_setup_tasks", "tasks",
          { account_id: accountId, data_source_id: (out as any).data_source_id },
          { workspace: (out as any).workspace });
      }
      return json(out);
    } catch (e) {
      return taskError(e, "setup_failed");
    }
  },
);
```

- [ ] **Step 5: tracker_url nas respostas existentes:**
  - `zinom_create_task`: no `json({...})` de sucesso adicionar `tracker_url: r.trackerUrl,` e na description acrescentar a linha final: `SEMPRE mostre o link clicável da tarefa (url) na resposta e ofereça o link do board (tracker_url) para abrir as tarefas no Notion.`
  - `zinom_plan_context`: capturar `let tracker_url: string | null = null;` e dentro do try do listTasks: `tracker_url = r.tracker_url;` e adicionar `tracker_url` ao json de resposta.
  - `zinom_list_tasks` description: acrescentar `Mostre tracker_url como link clicável ("abrir no Notion") quando apresentar o board.`
- [ ] **Step 6: rodar `npm run build` + `npm test`.**
- [ ] **Step 7: Commit** `feat(mcp): zinom_setup_tasks (página/workspace alvo) + tracker_url em create/list/plan`.

---

### Task 4: Portal — API + UI de escolha de destino e link (worktree `portal-targeting`, branch `feat/portal-tasks-targeting`) — DEPENDE da Task 1 mergeada

**Files:**
- Modify: `src/portal/routes.ts` (`POST /portal/tasks/create` com body; novo `GET /portal/tasks/pages`)
- Modify: `portal/app.js` (picker no card Tarefas + botão "Abrir no Notion ↗")
- Modify: `portal/app.html` (se precisar de container novo p/ picker — preferir gerar via JS no padrão atual)
- Test: `src/portal/__tests__/tasks-routes.test.ts`
- Check: `tests/e2e/us5-tasks-guide.spec.ts` (atualizar asserts de copy se quebrarem)

- [ ] **Step 1: testes que falham (seguir o harness existente de tasks-routes.test.ts):**
  - `POST /portal/tasks/create` com `{workspace, parent_page_id}` repassa ambos a `createTaskTracker` e responde 201 com `{data_source_id, url, title}`.
  - `GET /portal/tasks/pages?q=Projetos` responde `{pages:[...]}`; sem `q` responde `{pages:[]}` sem chamar a busca.
- [ ] **Step 2: implementar rotas:**

```ts
// Cria a DB "Tarefas". Aceita destino opcional: workspace e/ou parent_page_id
// (página existente). Sem destino: página-mãe "🧠 Zinom" no topo (comportamento
// histórico). Responde com o link do board para a UI mostrar "Abrir no Notion".
router.post("/portal/tasks/create", requireSession, async (req, res) => {
  const accountId: string = res.locals.accountId;
  const workspace =
    typeof req.body?.workspace === "string" && req.body.workspace.trim() ? req.body.workspace.trim() : undefined;
  const parentPageId =
    typeof req.body?.parent_page_id === "string" && req.body.parent_page_id.trim() ? req.body.parent_page_id.trim() : undefined;
  try {
    const { createTaskTracker } = await import("./task-tracker.js");
    const { invalidateTrackerProfile, getTasksInfo } = await import("../tasks/adapter.js");
    const { dataSourceId } = await createTaskTracker(accountId, { workspace, parentPageId });
    invalidateTrackerProfile(accountId);
    let info: { title: string | null; url: string | null } | null = null;
    try { info = await getTasksInfo(accountId); } catch { /* link opcional */ }
    res.status(201).json({ data_source_id: dataSourceId, url: info?.url ?? null, title: info?.title ?? null });
  } catch (err: any) {
    console.error(`[portal] tasks/create ${accountId}: ${err?.message ?? err}`);
    res.status(400).json({ error: err?.message ?? "não consegui criar as Tarefas" });
  }
});

// Busca páginas candidatas a "casa" da base de Tarefas (picker da UI).
router.get("/portal/tasks/pages", requireSession, async (req, res) => {
  const accountId: string = res.locals.accountId;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) { res.json({ pages: [] }); return; }
  try {
    const { searchParentPages } = await import("./task-tracker.js");
    res.json({ pages: await searchParentPages(accountId, q) });
  } catch (err: any) {
    console.error(`[portal] tasks/pages ${accountId}: ${err?.message ?? err}`);
    res.status(502).json({ error: "não consegui buscar páginas no seu Notion agora" });
  }
});
```

- [ ] **Step 3: UI (app.js):**
  - Estado configurado (`renderTasksCard`, ~linha 945): trocar `_tasksActions(...)` por: link primário `Abrir no Notion ↗` (quando `isHttpUrl(info.url)`) + botão ghost "Trocar de base" existente:
    `_tasksActions((isHttpUrl(info.url) ? '<a class="btn btn-primary btn-sm" href="' + escapeHtml(info.url) + '" target="_blank" rel="noopener">Abrir no Notion ↗</a> ' : '') + '<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Trocar de base</button>');`
  - Estado não configurado (~linha 962): manter os dois botões atuais e ADICIONAR um terceiro: `<button class="btn btn-ghost btn-sm" type="button" data-tasks-choose>Escolher onde criar…</button>`. Atualizar a copy da msg para: `Aponte uma base que você já tem, crie o Kanban padrão (página "🧠 Zinom" no topo do workspace) ou escolha em qual página do seu Notion ele nasce.`
  - Picker: handler delegado de `data-tasks-choose` (junto dos handlers `data-tasks-*` existentes) renderiza na área de msg um mini-form: `<input>` de busca + botão `data-tasks-search`; submit chama `GET /portal/tasks/pages?q=...` e lista cada página como botão `data-tasks-create-here data-page-id="..."` mostrando `título`; clique chama `POST /portal/tasks/create` com `{parent_page_id}` e, no 201, re-renderiza o card (reusar o fluxo pós-create atual) e mostra o link `url` retornado.
  - Seguir o estilo ES5/var do arquivo, `escapeHtml` em TUDO que vier do Notion.
- [ ] **Step 4: rodar `npm test`; grep no e2e `us5-tasks-guide.spec.ts` por copy/seletores alterados (ex.: o texto antigo "Aponte uma base que você já tem ou crie o Kanban padrão Zinom") e atualizar o spec. Rodar `npx playwright test tests/e2e/us5-tasks-guide.spec.ts` se o ambiente local suportar (precisa de Postgres dev); se não, registrar no relatório.**
- [ ] **Step 5: Commit** `feat(portal): escolher página/workspace do Kanban + link "Abrir no Notion"`.

---

### Task 5: Skills do projeto + /init (orquestrador, fora do repo engine)

- `.claude/skills/zinom-deploy/SKILL.md` e `.claude/skills/zinom-pr/SKILL.md` em `/Users/bruno.moniz/dev/zinom/` (workflows de deploy com verificação e de PR via API GitHub).
- `/init` para enriquecer o `CLAUDE.md` da raiz com o mapa dos dois repos.
- Executado pelo orquestrador com a skill `superpowers:writing-skills`.

### Task 6: Integração, PR, CI, merge, deploy, verificação (orquestrador)

1. Worktree `integracao`, branch `feat/tarefas-direcionadas` a partir de `main`; merge das branches das Tasks 1→2→3→4 (resolver conflitos triviais; 2 e 3 tocam arquivos disjuntos).
2. Copiar este plano para `docs/superpowers/plans/2026-06-11-tarefas-direcionadas-e-zinom-first.md` e commitar.
3. `npm ci && npm run build && npm test` verdes no worktree de integração.
4. Push da branch, PR via API GitHub (token via `git credential fill`, nunca imprimir), aguardar CI `build-test` verde, merge.
5. Deploy: `ssh zinom-vps "cd /home/moniz/notion-mcp && git pull --ff-only && npm ci && npm run build && npm run migrate && pm2 restart notion-mcp brain-indexer brain-classifier --update-env"`.
6. Verificar: `/health` 200; `/status` sem stale; `https://zinom.ai/mcp` → 401; `tools/list` do MCP (curl local na VPS com o bearer do .env, sem imprimir o token) contém `zinom_setup_tasks` e as instructions contêm "Zinom primeiro".
