# Zinom.ai — Rotina de Ativação (onboarding pós-conexão) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Após conectar as fontes, o portal mostra um checklist de ativação one-time que detecta/cria um Task Tracker no Notion da conta (isolado por `account_id`), confirma Granola/Calendário, e entrega prompts prontos pro assistente.

**Architecture:** Aditivo sobre o portal existente (`src/portal/*` + `portal/*`). Lógica de classificação de schema é PURA e isolada (`task-tracker-schema.ts`); a camada de rede chama a API do Notion via `fetch` cru (clients-free, com `fetchImpl` injetável pra teste) usando o token da conta no vault; estado de ativação e `tasks_db_id` ficam no vault cifrado já existente (sem migração). Rotas novas em `createPortalRouter()`, front no `app.html`/`app.js`.

**Tech Stack:** TypeScript + Express, node:test (`tsx --test`), Playwright e2e, Notion API `2025-09-03` (via `fetch`), vault AES-256-GCM (`secrets.ts`).

**Repo de código:** `BrunooMoniz/notion-mcp` (working copy `.context/notion-mcp/`). Spec: `docs/superpowers/specs/2026-06-06-zinom-onboarding-ativacao-design.md` (repo de planejamento).

---

## Decisões de implementação (derivadas da spec + leitura do código)

- **Sem migração.** `tasks_db_id` → vault kind `tasks_db` (string). Estado de ativação → vault kind `activation` (JSON `{ask?:boolean, dismissed?:boolean}`). Reusa `setAccountSecret`/`getAccountSecret`/`deleteAccountSecret` (`src/secrets.ts`). Cabe na decisão D ("coluna OU vault") da spec.
- **Clients-free.** O módulo NÃO importa `clients.ts` (que dá `process.exit()` sem `NOTION_*_TOKEN`). Chama o Notion com `fetch` + header `Notion-Version: 2025-09-03`, exatamente como `src/notion-oauth.ts`. Token da conta vem de `warmAccount()` + `getAccountToken()` (`src/account-tokens.ts`).
- **Adaptar DB existente (adicionar campos faltantes) FORA do MVP.** O único consumidor de "Tempo estimado" é o `/meu-dia`, que está fora do MVP. Se a pessoa já tem DB de tarefas, só gravamos o `tasks_db_id` dela. Completar o schema vai junto com o wiring do planejador, depois.
- **Detecção conservadora (D2):** candidata = DB com (campo status-like **e** date-like) OU nome casando `tarefa|task|to-?do|afazer` (acento/caixa-insensível). `none`/`one`/`many`/`no-notion`. Nunca escreve sem confirmação.
- **Criação (D1):** cria página-mãe "🧠 Zinom" no topo do workspace + DB "Tarefas" dentro, com o schema-alvo. Funciona direto via PAT (acesso total do usuário). Pra OAuth com escopo restrito, criar no topo pode falhar → erro claro (risco anotado).
- **Desvio de teste vs spec:** o loop "criar → `tasks_db_id` gravado → item ✅" é provado por **teste de integração com `fetch` injetado + stub pool** (não Playwright), porque o dev-server do e2e não tem Notion ao vivo. O Playwright cobre as superfícies do portal que não dependem de Notion (render do checklist, estados de Granola/Calendário, ack/dismiss persistentes). Mesma cobertura, camada diferente.

## Estrutura de arquivos

- **Criar** `src/portal/task-tracker-schema.ts` — PURO: schema-alvo, regexes, classificadores, builders de payload. Sem imports de storage/notion.
- **Criar** `src/portal/task-tracker.ts` — rede + persistência: `fetch` cru ao Notion, resolução de token da conta, `detectTaskTracker`, `createTaskTracker`, `useExistingTracker`, `getTasksDbId`/`setTasksDbId`.
- **Criar** `src/portal/activation.ts` — estado de ativação sobre o vault: `getActivationState`, `markAsked`, `dismissActivation`.
- **Modificar** `src/portal/routes.ts` — 6 rotas novas (todas `requireSession`, imports pesados lazy).
- **Modificar** `portal/app.html` — card "Ativação" + bloco de checklist.
- **Modificar** `portal/app.js` — `renderActivation()` + handlers.
- **Criar** `src/portal/__tests__/task-tracker-schema.test.ts`, `src/portal/__tests__/task-tracker.test.ts`, `src/portal/__tests__/activation.test.ts`.
- **Criar** `tests/e2e/us4-activation.spec.ts`.

> Todos os comandos rodam de dentro de `.context/notion-mcp/`.

---

## Task 0: Verificar shapes da API Notion 2025-09-03 (Context7)

CLAUDE.md exige consultar a doc atual antes de escrever código contra a API. Três shapes a confirmar antes das tasks de rede (Tasks 2 e 4): (a) criar página no **topo do workspace** (`parent: {type:"workspace", workspace:true}` + property `title`); (b) `POST /v1/databases` create e o formato da resposta (campo `data_sources[].id`); (c) `POST /v1/search` com `filter:{property:"object", value:"data_source"}`.

- [ ] **Step 1: Resolver a lib e puxar a doc**

Use o MCP Context7: `resolve-library-id` para "Notion API", depois `query-docs` com tópicos "create a page at workspace level", "create a database", "search by object data_source", versão `2025-09-03`.

- [ ] **Step 2: Anotar divergências**

Se algum shape divergir do escrito nas Tasks 2/4 (ex.: criação de página no topo não suportada, ou create de DB migrou pra `/v1/data_sources`), ajuste o código das Tasks 2/4 antes de implementá-las. Sem código a commitar aqui — é um gate de pesquisa.

### Resultados (2026-06-06, via Context7 — confirmados)

1. **`POST /v1/databases` (2025-09-03):** o schema migrou pra `initial_data_source.properties` (não mais `properties` no topo — "properties previously at the database level are now part of data sources"). A resposta é um objeto `database` com `data_sources: [{id, name}]`. → **`buildCreateDbPayload` envolve o schema em `initial_data_source`**; o teste da Task 1 checa `p.initial_data_source.properties`. `createTaskTracker` guarda `db.data_sources[0].id`.
2. **`POST /v1/search` com filtro `data_source`:** o objeto data_source retornado tem **só** `object/id/title/description` — **não traz `properties`**. → **`detectTaskTracker` faz, por candidata (com cap), um `GET /v1/data_sources/{id}` pra obter `properties`** antes de classificar. O teste da Task 2 mocka `/v1/search` (ids+títulos) **e** `/v1/data_sources/{id}` (properties).
3. **Página no topo:** `parent:{type:"workspace", workspace:true}` + property `title` confirmado. Sem mudança.

---

## Task 1: Módulo puro de classificação de schema

**Files:**
- Create: `src/portal/task-tracker-schema.ts`
- Test: `src/portal/__tests__/task-tracker-schema.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
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

test("buildCreateDbPayload usa o parent page e o schema-alvo", () => {
  const p = buildCreateDbPayload("PAGE_ID");
  assert.deepEqual(p.parent, { type: "page_id", page_id: "PAGE_ID" });
  assert.equal(p.title[0].text.content, "Tarefas");
  assert.equal(p.properties, TARGET_PROPERTIES);
  // schema-alvo tem os campos que o /meu-dia espera
  for (const k of ["Nome", "Status", "Prazo", "Tempo estimado", "Frente"]) {
    assert.ok(k in TARGET_PROPERTIES, `falta ${k}`);
  }
  assert.equal(TARGET_PROPERTIES["Nome"].title !== undefined, true);
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx tsx --test src/portal/__tests__/task-tracker-schema.test.ts`
Expected: FAIL — `Cannot find module '../task-tracker-schema.js'`.

- [ ] **Step 3: Implementar o módulo puro**

```typescript
// src/portal/task-tracker-schema.ts
// 001-account-portal / ativação — classificação PURA de data sources do Notion
// (decide se uma DB é candidata a Task Tracker) e builders dos payloads de criação.
// Sem imports de rede/storage: 100% testável.

export const ZINOM_PARENT_TITLE = "🧠 Zinom";
export const TARGET_DB_TITLE = "Tarefas";

/** Schema-alvo da DB "Tarefas" — o mínimo que o /meu-dia espera. */
export const TARGET_PROPERTIES: Record<string, any> = {
  Nome: { title: {} },
  Status: {
    select: { options: [{ name: "A fazer" }, { name: "Fazendo" }, { name: "Feito" }] },
  },
  Prazo: { date: {} },
  "Tempo estimado": { number: { format: "number" } },
  Frente: { select: { options: [] } },
};

const TASKLIKE_NAME_RE = /tarefa|task|to-?do|afazer/i;

/** Remove acentos e baixa a caixa, pra casar nome de DB de forma robusta. */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

type NotionProps = Record<string, { type?: string; select?: { options?: Array<{ name?: string }> } }>;

/** Algum campo é "status-like": type status, ou um select cujo nome/opções soam a status. */
export function hasStatusLike(properties: NotionProps): boolean {
  for (const [name, def] of Object.entries(properties ?? {})) {
    if (def?.type === "status") return true;
    if (def?.type === "select") {
      const n = normalize(name);
      if (/status|situa|estado|stage|etapa/.test(n)) return true;
      const opts = (def.select?.options ?? []).map((o) => normalize(o.name ?? "")).join(" ");
      if (/fazer|fazendo|feito|done|todo|to do|andamento|conclu/.test(opts)) return true;
    }
  }
  return false;
}

/** Algum campo é do tipo date. */
export function hasDateLike(properties: NotionProps): boolean {
  return Object.values(properties ?? {}).some((d) => d?.type === "date");
}

export interface DataSourceLite {
  id: string;
  title: string;
  properties: NotionProps;
}

export function isTaskTrackerCandidate(ds: { title: string; properties: NotionProps }): boolean {
  if (TASKLIKE_NAME_RE.test(normalize(ds.title))) return true;
  return hasStatusLike(ds.properties) && hasDateLike(ds.properties);
}

export interface Detection {
  status: "none" | "one" | "many";
  candidates: Array<{ id: string; title: string }>;
}

export function classifyResults(dataSources: DataSourceLite[]): Detection {
  const candidates = dataSources
    .filter((d) => isTaskTrackerCandidate(d))
    .map((d) => ({ id: d.id, title: d.title }));
  const status = candidates.length === 0 ? "none" : candidates.length === 1 ? "one" : "many";
  return { status, candidates };
}

/** Payload de POST /v1/pages: página-mãe "🧠 Zinom" no topo do workspace. */
export function buildParentPagePayload(): {
  parent: { type: "workspace"; workspace: true };
  properties: { title: { title: Array<{ text: { content: string } }> } };
} {
  return {
    parent: { type: "workspace", workspace: true },
    properties: { title: { title: [{ text: { content: ZINOM_PARENT_TITLE } }] } },
  };
}

/** Payload de POST /v1/databases: DB "Tarefas" dentro da página-mãe. */
export function buildCreateDbPayload(parentPageId: string): {
  parent: { type: "page_id"; page_id: string };
  title: Array<{ type: "text"; text: { content: string } }>;
  properties: Record<string, any>;
} {
  return {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: TARGET_DB_TITLE } }],
    properties: TARGET_PROPERTIES,
  };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx tsx --test src/portal/__tests__/task-tracker-schema.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/portal/task-tracker-schema.ts src/portal/__tests__/task-tracker-schema.test.ts
git commit -m "feat(portal): classificador puro de Task Tracker + builders de payload"
```

---

## Task 2: Camada de rede/persistência — detecção + persistência do tasks_db_id

**Files:**
- Create: `src/portal/task-tracker.ts`
- Test: `src/portal/__tests__/task-tracker.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// src/portal/__tests__/task-tracker.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);

import {
  detectTaskTracker,
  getTasksDbId,
  setTasksDbId,
  createTaskTracker,
  useExistingTracker,
} from "../task-tracker.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __clearAccountTokenCache } from "../../account-tokens.js";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value
let workspaces: string[];

// Minimal pool: account_secrets vault + account_workspaces lookup used by warmAccount.
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM account_workspaces/i.test(sql)) {
        return { rows: workspaces.map((w) => ({ workspace: w })) };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  store = new Map();
  workspaces = [];
  __setPoolForTest(memPool() as never);
  __clearAccountTokenCache();
});
afterEach(() => {
  __setPoolForTest(null);
  __clearAccountTokenCache();
});

// Seed a connected Notion workspace with a PAT in the vault, so warmAccount finds a token.
async function seedNotion(accountId: string, ws = "ws-1") {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret(accountId, `notion_pat:${ws}`, "ntn_fake");
  workspaces = [ws];
}

function fakeFetch(routes: Record<string, any>): typeof fetch {
  return (async (url: string, init?: any) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const body = key ? routes[key] : { object: "list", results: [] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(typeof body === "function" ? body(init) : body),
    };
  }) as any;
}

test("detect: sem Notion conectado → no-notion (não chama a API)", async () => {
  const det = await detectTaskTracker("friend:x", { fetchImpl: fakeFetch({}) });
  assert.equal(det.status, "no-notion");
});

test("detect: search retorna candidata única → one", async () => {
  await seedNotion("friend:x");
  const det = await detectTaskTracker("friend:x", {
    fetchImpl: fakeFetch({
      "/v1/search": {
        results: [
          { id: "ds1", object: "data_source", title: [{ plain_text: "Tarefas" }], properties: { Nome: { type: "title" } } },
          { id: "ds2", object: "data_source", title: [{ plain_text: "Notas" }], properties: { Nome: { type: "title" } } },
        ],
      },
    }),
  });
  assert.equal(det.status, "one");
  assert.deepEqual(det.candidates, [{ id: "ds1", title: "Tarefas" }]);
});

test("get/set tasks_db_id via vault", async () => {
  assert.equal(await getTasksDbId("friend:x"), null);
  await setTasksDbId("friend:x", "ds-99");
  assert.equal(await getTasksDbId("friend:x"), "ds-99");
});

test("useExistingTracker grava o id escolhido", async () => {
  await useExistingTracker("friend:x", "ds-chosen");
  assert.equal(await getTasksDbId("friend:x"), "ds-chosen");
});

test("createTaskTracker: cria página + DB, grava o data_source id", async () => {
  await seedNotion("friend:x");
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    const u = String(url);
    calls.push(u);
    let body: any = {};
    if (u.includes("/v1/pages")) body = { id: "page-1" };
    else if (u.includes("/v1/databases")) body = { id: "db-1", data_sources: [{ id: "ds-new" }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;

  const res = await createTaskTracker("friend:x", { fetchImpl });
  assert.equal(res.dataSourceId, "ds-new");
  assert.equal(await getTasksDbId("friend:x"), "ds-new");
  assert.ok(calls.some((c) => c.includes("/v1/pages")));
  assert.ok(calls.some((c) => c.includes("/v1/databases")));
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx tsx --test src/portal/__tests__/task-tracker.test.ts`
Expected: FAIL — `Cannot find module '../task-tracker.js'`.

- [ ] **Step 3: Implementar o módulo**

```typescript
// src/portal/task-tracker.ts
// 001-account-portal / ativação — camada de rede + persistência do Task Tracker.
// Clients-free: chama a API do Notion via fetch cru (igual src/notion-oauth.ts),
// com o token da conta resolvido do vault. tasks_db_id mora no vault (kind
// "tasks_db"), então NÃO precisa de migração. fetchImpl é injetável p/ teste.
import { warmAccount, getAccountToken } from "../account-tokens.js";
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import {
  classifyResults,
  buildParentPagePayload,
  buildCreateDbPayload,
  type Detection,
  type DataSourceLite,
} from "./task-tracker-schema.js";

const NOTION_VERSION = "2025-09-03"; // manter em sincronia com clients.ts
const NOTION_API = "https://api.notion.com";
const TASKS_DB_KIND = "tasks_db";

/** Token + workspace da conta (primeiro workspace com token), ou null. */
async function resolveAccountNotion(
  accountId: string,
): Promise<{ token: string; workspace: string } | null> {
  const workspaces = await warmAccount(accountId);
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (token) return { token, workspace: ws };
  }
  return null;
}

async function notionFetch(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Notion: resposta não-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`Notion ${path}: HTTP ${res.status} ${data?.code ?? ""} ${data?.message ?? ""}`.trim());
  }
  return data;
}

function plainTitle(title: unknown): string {
  if (!Array.isArray(title)) return "";
  return title.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim();
}

/** Detecta candidatas a Task Tracker no Notion da conta. Sem Notion → no-notion. */
export async function detectTaskTracker(
  accountId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Detection | { status: "no-notion"; candidates: [] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId);
  if (!conn) return { status: "no-notion", candidates: [] };

  const out = await notionFetch(
    conn.token,
    "/v1/search",
    { method: "POST", body: JSON.stringify({ filter: { property: "object", value: "data_source" } }) },
    fetchImpl,
  );
  const results: DataSourceLite[] = (out.results ?? []).map((r: any) => ({
    id: r.id,
    title: plainTitle(r.title),
    properties: r.properties ?? {},
  }));
  return classifyResults(results);
}

export async function getTasksDbId(accountId: string): Promise<string | null> {
  return (await getAccountSecret(accountId, TASKS_DB_KIND)) ?? null;
}

export async function setTasksDbId(accountId: string, dataSourceId: string): Promise<void> {
  await setAccountSecret(accountId, TASKS_DB_KIND, dataSourceId);
}

/** Usa uma DB existente escolhida pela pessoa: só grava o id (MVP não muta schema). */
export async function useExistingTracker(accountId: string, dataSourceId: string): Promise<void> {
  await setTasksDbId(accountId, dataSourceId);
}

/** Cria "🧠 Zinom" (topo do workspace) + DB "Tarefas" dentro, grava o data_source id. */
export async function createTaskTracker(
  accountId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ dataSourceId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId);
  if (!conn) throw new Error("conecte o Notion antes de criar as Tarefas");

  const page = await notionFetch(
    conn.token,
    "/v1/pages",
    { method: "POST", body: JSON.stringify(buildParentPagePayload()) },
    fetchImpl,
  );
  if (!page?.id) throw new Error("não consegui criar a página-mãe no Notion");

  const db = await notionFetch(
    conn.token,
    "/v1/databases",
    { method: "POST", body: JSON.stringify(buildCreateDbPayload(page.id)) },
    fetchImpl,
  );
  // Sob 2025-09-03 o database criado expõe data_sources[]; guardamos o id do data
  // source (é o que se consulta). Fallback p/ o id do database se ausente.
  const dataSourceId: string = db?.data_sources?.[0]?.id ?? db?.id;
  if (!dataSourceId) throw new Error("Notion não retornou o id da base criada");
  await setTasksDbId(accountId, dataSourceId);
  return { dataSourceId };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx tsx --test src/portal/__tests__/task-tracker.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/portal/task-tracker.ts src/portal/__tests__/task-tracker.test.ts
git commit -m "feat(portal): detecção/criação de Task Tracker por conta (clients-free)"
```

---

## Task 3: Estado de ativação (vault)

**Files:**
- Create: `src/portal/activation.ts`
- Test: `src/portal/__tests__/activation.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// src/portal/__tests__/activation.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);

import { getActivationState, markAsked, dismissActivation } from "../activation.js";
import { setTasksDbId } from "../task-tracker.js";
import { setGranolaKey, addIcalLink } from "../sources.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>;
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}
beforeEach(() => { store = new Map(); __setPoolForTest(memPool() as never); });
afterEach(() => __setPoolForTest(null));

test("conta nova: nada feito, não completa", async () => {
  const s = await getActivationState("friend:1");
  assert.deepEqual(s.items, { tasks: false, granola: false, ical: false, ask: false });
  assert.equal(s.complete, false);
  assert.equal(s.dismissed, false);
});

test("itens refletem fontes + tasks_db_id + ask; completa quando os 4 batem", async () => {
  await setTasksDbId("friend:1", "ds-1");
  await setGranolaKey("friend:1", "grn_key_zzzz");
  await addIcalLink("friend:1", { url: "https://x/y.ics", label: "Pessoal" });
  let s = await getActivationState("friend:1");
  assert.deepEqual(s.items, { tasks: true, granola: true, ical: true, ask: false });
  assert.equal(s.complete, false); // falta o ask

  await markAsked("friend:1");
  s = await getActivationState("friend:1");
  assert.equal(s.items.ask, true);
  assert.equal(s.complete, true);
});

test("dismiss esconde o checklist mesmo sem completar", async () => {
  await dismissActivation("friend:1");
  const s = await getActivationState("friend:1");
  assert.equal(s.dismissed, true);
  assert.equal(s.complete, true); // dismissed conta como concluído p/ esconder
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx tsx --test src/portal/__tests__/activation.test.ts`
Expected: FAIL — `Cannot find module '../activation.js'`.

- [ ] **Step 3: Implementar o módulo**

```typescript
// src/portal/activation.ts
// 001-account-portal / ativação — estado do checklist one-time, derivado das
// fontes conectadas + tasks_db_id + um flag "ask"/"dismissed" no vault (kind
// "activation"). Sem migração. complete = 4 itens OU dismissed (p/ esconder).
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import { getTasksDbId } from "./task-tracker.js";
import { getGranolaMasked, getIcalLinks } from "./sources.js";

const ACTIVATION_KIND = "activation";

interface ActivationFlags {
  ask?: boolean;
  dismissed?: boolean;
}

async function readFlags(accountId: string): Promise<ActivationFlags> {
  const raw = await getAccountSecret(accountId, ACTIVATION_KIND);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as ActivationFlags) : {};
  } catch {
    return {};
  }
}

async function writeFlags(accountId: string, patch: ActivationFlags): Promise<void> {
  const next = { ...(await readFlags(accountId)), ...patch };
  await setAccountSecret(accountId, ACTIVATION_KIND, JSON.stringify(next));
}

export interface ActivationState {
  items: { tasks: boolean; granola: boolean; ical: boolean; ask: boolean };
  dismissed: boolean;
  complete: boolean;
}

export async function getActivationState(accountId: string): Promise<ActivationState> {
  const flags = await readFlags(accountId);
  const tasks = (await getTasksDbId(accountId)) != null;
  const granola = (await getGranolaMasked(accountId)).set;
  const ical = (await getIcalLinks(accountId)).length > 0;
  const ask = flags.ask === true;
  const items = { tasks, granola, ical, ask };
  const allDone = tasks && granola && ical && ask;
  const dismissed = flags.dismissed === true;
  return { items, dismissed, complete: allDone || dismissed };
}

export async function markAsked(accountId: string): Promise<void> {
  await writeFlags(accountId, { ask: true });
}

export async function dismissActivation(accountId: string): Promise<void> {
  await writeFlags(accountId, { dismissed: true });
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx tsx --test src/portal/__tests__/activation.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/portal/activation.ts src/portal/__tests__/activation.test.ts
git commit -m "feat(portal): estado do checklist de ativação (vault, sem migração)"
```

---

## Task 4: Rotas do portal

**Files:**
- Modify: `src/portal/routes.ts` (adicionar 6 rotas dentro de `createPortalRouter()`, antes do `return router;` na linha ~339)

- [ ] **Step 1: Adicionar as rotas (imports pesados lazy, igual /reindex)**

Inserir logo antes de `return router;`:

```typescript
  // --- Ativação (checklist one-time) ----------------------------------------
  router.get("/portal/activation", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    const { getActivationState } = await import("./activation.js");
    res.json(await getActivationState(accountId));
  });

  // Detecta candidatas a Task Tracker no Notion da conta (não escreve nada).
  router.post("/portal/tasks/detect", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { detectTaskTracker } = await import("./task-tracker.js");
      res.json(await detectTaskTracker(accountId));
    } catch (err: any) {
      console.error(`[portal] tasks/detect ${accountId}: ${err?.message ?? err}`);
      res.status(502).json({ error: "não consegui ler seu Notion agora" });
    }
  });

  // Cria a DB "Tarefas" (página-mãe "🧠 Zinom" no topo). Só com confirmação (POST).
  router.post("/portal/tasks/create", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { createTaskTracker } = await import("./task-tracker.js");
      const { dataSourceId } = await createTaskTracker(accountId);
      res.status(201).json({ data_source_id: dataSourceId });
    } catch (err: any) {
      console.error(`[portal] tasks/create ${accountId}: ${err?.message ?? err}`);
      res.status(400).json({ error: err?.message ?? "não consegui criar as Tarefas" });
    }
  });

  // Usa uma DB existente que a pessoa escolheu (grava o id; não muta schema no MVP).
  router.post("/portal/tasks/use", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const id = typeof req.body?.data_source_id === "string" ? req.body.data_source_id.trim() : "";
    if (!id) {
      res.status(400).json({ error: "data_source_id obrigatório" });
      return;
    }
    const { useExistingTracker } = await import("./task-tracker.js");
    await useExistingTracker(accountId, id);
    res.sendStatus(200);
  });

  router.post("/portal/activation/ask", requireSession, async (_req, res) => {
    const { markAsked } = await import("./activation.js");
    await markAsked(res.locals.accountId);
    res.sendStatus(200);
  });

  router.post("/portal/activation/dismiss", requireSession, async (_req, res) => {
    const { dismissActivation } = await import("./activation.js");
    await dismissActivation(res.locals.accountId);
    res.sendStatus(200);
  });
```

- [ ] **Step 2: Compilar pra garantir tipos**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Rodar a suíte do portal (regressão)**

Run: `npm test`
Expected: tudo verde (incluindo os 3 arquivos novos das Tasks 1-3).

- [ ] **Step 4: Commit**

```bash
git add src/portal/routes.ts
git commit -m "feat(portal): rotas de ativação (activation/detect/create/use/ask/dismiss)"
```

---

## Task 5: Front — checklist de ativação

**Files:**
- Modify: `portal/app.html` (adicionar o card do checklist após o card MCP, antes de `<div id="notion-notice">` ~linha 35)
- Modify: `portal/app.js` (adicionar `renderActivation()` + handlers; chamar em `load()`)

- [ ] **Step 1: Adicionar o card no app.html**

Inserir após o card "Conectar ao seu assistente" (depois da linha 33, antes de `<div id="notion-notice">`):

```html
  <!-- Checklist de ativação (one-time) -->
  <div class="card hidden" id="activation">
    <strong>🚀 Ative seu Zinom</strong>
    <p class="muted">4 passos pra começar a tirar valor. Some quando terminar.</p>
    <ul id="activation-items" style="list-style:none;padding:0;margin:8px 0"></ul>

    <!-- Sub-bloco Tarefas (renderizado conforme a detecção) -->
    <div id="act-tasks" class="hidden" style="margin:8px 0;padding:10px;border:1px solid #eee;border-radius:8px">
      <p class="muted" id="act-tasks-msg"></p>
      <div id="act-tasks-actions"></div>
    </div>

    <!-- Sub-bloco Pergunte ao Zinom -->
    <div id="act-ask" class="hidden" style="margin:8px 0;padding:10px;border:1px solid #eee;border-radius:8px">
      <p class="muted">Abra o Claude (com o Zinom conectado) e experimente:</p>
      <ul id="act-prompts" class="muted" style="padding-left:18px;line-height:1.7"></ul>
      <button class="small" id="act-ask-done">Já testei ✅</button>
    </div>

    <button class="secondary small" id="act-dismiss" style="margin-top:8px">Pular por enquanto</button>
  </div>
```

- [ ] **Step 2: Adicionar a lógica no app.js**

Adicionar antes da chamada final `load();` (linha ~157), e inserir `await renderActivation(s);` ao fim de `load()` (após o loop do iCal, antes do fechamento da função na linha 63):

```javascript
// (dentro de load(), após renderizar iCal, antes do '}' da função)
  await renderActivation(s);
```

```javascript
// novas funções (perto do fim do arquivo, antes de notionNotice())
const LABELS = { tasks: "Tarefas no Notion", granola: "Granola", ical: "Calendário", ask: "Pergunte ao Zinom" };

async function renderActivation(sources) {
  const res = await api("/portal/activation");
  if (!res.ok) return;
  const st = await res.json();
  const card = document.getElementById("activation");
  if (st.complete) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const ul = document.getElementById("activation-items");
  ul.innerHTML = "";
  for (const k of ["tasks", "granola", "ical", "ask"]) {
    const li = document.createElement("li");
    li.style.padding = "3px 0";
    li.textContent = `${st.items[k] ? "✅" : "⬜️"} ${LABELS[k]}`;
    ul.appendChild(li);
  }

  // Tarefas: se ainda não feito, oferecer detectar/criar
  const taskBox = document.getElementById("act-tasks");
  if (st.items.tasks) {
    taskBox.classList.add("hidden");
  } else {
    taskBox.classList.remove("hidden");
    const notion = sources && sources.notion && sources.notion.connected;
    const msg = document.getElementById("act-tasks-msg");
    const actions = document.getElementById("act-tasks-actions");
    actions.innerHTML = "";
    if (!notion) {
      msg.textContent = "Conecte seu Notion acima primeiro — aí eu organizo suas tarefas.";
    } else {
      msg.textContent = "Vou procurar (ou criar) uma base de Tarefas no seu Notion.";
      const detectBtn = document.createElement("button");
      detectBtn.className = "small";
      detectBtn.textContent = "Procurar / criar Tarefas";
      detectBtn.onclick = () => detectTasks();
      actions.appendChild(detectBtn);
    }
  }

  // Pergunte ao Zinom: mostra prompts calibrados; permite marcar como testado
  const askBox = document.getElementById("act-ask");
  if (st.items.ask) {
    askBox.classList.add("hidden");
  } else {
    askBox.classList.remove("hidden");
    const prompts = document.getElementById("act-prompts");
    prompts.innerHTML = "";
    const list = ["o que rolou nas minhas últimas reuniões?", "o que ficou pendente sobre [meu projeto]?"];
    if (st.items.tasks) list.push("planeje meu dia");
    for (const p of list) {
      const li = document.createElement("li");
      li.textContent = `“${p}”`;
      prompts.appendChild(li);
    }
  }
}

async function detectTasks() {
  const actions = document.getElementById("act-tasks-actions");
  const msg = document.getElementById("act-tasks-msg");
  msg.textContent = "Procurando no seu Notion…";
  actions.innerHTML = "";
  const res = await apiJSON("/portal/tasks/detect", "POST");
  const det = await res.json().catch(() => ({ status: "error" }));
  if (det.status === "no-notion") {
    msg.textContent = "Conecte seu Notion acima primeiro.";
    return;
  }
  if (det.status === "none" || det.status === "error") {
    msg.textContent = "Não achei uma base de tarefas. Quero criar uma pra você (“🧠 Zinom › Tarefas”)?";
    const create = document.createElement("button");
    create.className = "small";
    create.textContent = "Criar Tarefas pra mim";
    create.onclick = createTasks;
    actions.appendChild(create);
    return;
  }
  // one/many: deixar a pessoa escolher usar uma existente, ou criar nova
  msg.textContent = "Encontrei isto no seu Notion. Use uma, ou crie uma nova:";
  for (const c of det.candidates) {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = `Usar “${c.title}”`;
    b.onclick = () => useTasks(c.id);
    actions.appendChild(b);
  }
  const create = document.createElement("button");
  create.className = "small secondary";
  create.textContent = "Criar nova";
  create.onclick = createTasks;
  actions.appendChild(create);
}

async function createTasks() {
  const msg = document.getElementById("act-tasks-msg");
  msg.textContent = "Criando…";
  const res = await apiJSON("/portal/tasks/create", "POST");
  if (res.ok) { load(); } else {
    const b = await res.json().catch(() => ({}));
    msg.textContent = b.error || "Não consegui criar. Tente o token (PAT) no card do Notion.";
  }
}

async function useTasks(id) {
  await apiJSON("/portal/tasks/use", "POST", { data_source_id: id });
  load();
}

document.getElementById("act-ask-done").onclick = async () => {
  await apiJSON("/portal/activation/ask", "POST");
  load();
};
document.getElementById("act-dismiss").onclick = async () => {
  await apiJSON("/portal/activation/dismiss", "POST");
  load();
};
```

- [ ] **Step 3: Smoke manual do front (sem Notion)**

Run: `npm run dev:portal` (precisa de POSTGRES_URL com `scripts/portal-dev-schema.sql` + SECRETS_KEY). Abra o portal, entre via magic link (modo DEV loga o link), confirme: o card "🚀 Ative seu Zinom" aparece; sem Notion, o passo Tarefas diz "Conecte seu Notion primeiro"; "Já testei" e "Pular" escondem itens/checklist e persistem após reload. Encerre o dev server.

- [ ] **Step 4: Commit**

```bash
git add portal/app.html portal/app.js
git commit -m "feat(portal): UI do checklist de ativação (detectar/criar Tarefas + prompts)"
```

---

## Task 6: E2E Playwright (superfícies sem Notion ao vivo)

**Files:**
- Create: `tests/e2e/us4-activation.spec.ts`

> Cobre o que o dev-server consegue sem Notion: render do checklist, passo Tarefas pedindo Notion, ack/dismiss persistentes. O loop de criação real (com Notion) é coberto pelo teste de integração da Task 2.

- [ ] **Step 1: Escrever o teste**

```typescript
// tests/e2e/us4-activation.spec.ts
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("checklist de ativação aparece e o passo Tarefas pede o Notion", async ({ page, request }) => {
  await registerAndSignIn(page, request);
  await expect(page.locator("#activation")).toBeVisible();
  await expect(page.locator("#activation-items")).toContainText("Tarefas no Notion");
  // Sem Notion conectado, o sub-bloco de Tarefas orienta a conectar.
  await expect(page.locator("#act-tasks-msg")).toContainText("Notion");
});

test("'Já testei' e 'Pular' persistem após reload", async ({ page, request }) => {
  await registerAndSignIn(page, request);
  await page.click("#act-ask-done");
  // O item ask vira ✅ (recarrega via load()).
  await expect(page.locator("#activation-items")).toContainText("✅ Pergunte ao Zinom");

  await page.click("#act-dismiss");
  // Dismiss esconde o card inteiro.
  await expect(page.locator("#activation")).toBeHidden();

  await page.reload();
  await expect(page.locator("#activation")).toBeHidden(); // persistiu
});
```

- [ ] **Step 2: Rodar o e2e**

Run: `npx playwright test tests/e2e/us4-activation.spec.ts`
Expected: PASS. (Precisa do setup de e2e já existente: DB `notion_mcp_e2e` + dev-server em `PORTAL_TEST_MODE=1`; ver `tests/e2e/helpers.ts` e a config do Playwright.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/us4-activation.spec.ts
git commit -m "test(e2e): checklist de ativação (render, passo Tarefas, ack/dismiss)"
```

---

## Task 7: Verificação final

- [ ] **Step 1: Suíte unit completa**

Run: `npm test`
Expected: verde (todos, incl. os novos).

- [ ] **Step 2: Build / tipos**

Run: `npm run build`
Expected: `tsc` sem erros.

- [ ] **Step 3: Boot de produção (sanidade)**

Run: `node -e "require('./dist/index.js')"` com env mínima OU verifique que `npm run build` gerou `dist/portal/*.js`. Não subir em prod (deploy só com OK do Bruno).

- [ ] **Step 4: E2E completo (não regredir US1-US3)**

Run: `npx playwright test`
Expected: verde (us1/us2/us3 + us4).

---

## Riscos / notas

- **Criação no topo do workspace (D1):** via PAT (acesso total do usuário) funciona; via OAuth com escopo restrito, criar página no topo pode dar 403. O erro é exibido ao usuário com sugestão de usar o PAT (já suportado no card do Notion). Confirmado o shape na Task 0.
- **`/v1/databases` create sob 2025-09-03:** a resposta deve trazer `data_sources[].id`; guardamos esse id (com fallback pro id do database). Validado na Task 0 + no teste da Task 2.
- **`/meu-dia` ainda não consome `tasks_db_id`** (fora do MVP). Esta feature só persiste o id; ligar o planejador é trabalho posterior (depende de distribuir skill por conta).
- **Item "ask" não é verificável do backend** — é ação leve no portal ("Já testei"). Aceito (é handoff).
- **Sem migração** — estado no vault existente; nada a aplicar em prod além do deploy normal de código.
