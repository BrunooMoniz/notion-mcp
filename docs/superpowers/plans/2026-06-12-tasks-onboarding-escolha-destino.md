# Tasks Onboarding: escolha explícita de workspace e página — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Este arquivo deve ser commitado em `docs/superpowers/plans/2026-06-12-tasks-onboarding-escolha-destino.md` pelo Épico 1.

**Goal:** O usuário (recém-onboardado ou já configurado) escolhe explicitamente em QUAL workspace e em QUAL página o Gestor de Tarefas padrão Zinom nasce; o Zinom nunca mais adota silenciosamente um board alheio nem cria base no "primeiro workspace" sem perguntar.

**Architecture:** Três mudanças coordenadas por um contrato de erro único (`WorkspaceRequiredError`, detectado por `name`, nunca por `instanceof` entre épicos): (1) backend `src/portal/task-tracker.ts` deixa de usar o primeiro workspace silenciosamente e restringe o reuse-guard ao fingerprint do template Zinom; (2) o front do portal ganha seletor de workspace + picker de página em TODOS os estados (não-configurado e configurado); (3) as tools MCP devolvem `workspace_required` com a lista de workspaces em vez de criar às cegas. Migração de tarefas antigas fica FORA do escopo (o usuário pede depois, sob demanda).

**Tech Stack:** TypeScript + Express, Notion API 2025-09-03 (fetch cru injetável), node:test via tsx, front estático vanilla JS (portal/app.js + portal/app.html).

**Bug de origem (contexto):** a conta do portal de brunoomoniz@gmail.com apontou para o db "Tarefas" da Global Cripto porque `resolveAccountNotion` pega `all[0]` (primeiro workspace) e `findReusableTrackerId` adota QUALQUER data source chamada "Tarefas" (task-tracker.ts:67 e 193-218). A UI só permite escolher destino no estado "não configurada" (app.js:967-974) e o detect varre só o primeiro workspace lendo até 40 schemas (caro).

**Critério de aceite verificado por máquina:**
1. `npm run build` verde.
2. `npm test` verde, incluindo os testes novos descritos abaixo.
3. CI `build-test` verde no PR.
4. Pós-deploy: `curl -s -o /dev/null -w '%{http_code}' https://zinom.ai/mcp` responde 401 e `/health` 200.

**Fora do escopo:** migração de tarefas entre boards; mudanças no fallback do owner (`OWNER_TASKS_DS_FALLBACK`); refactors fora dos arquivos listados.

---

## Contrato compartilhado entre épicos (NÃO alterar sem atualizar os 3)

1. `WorkspaceRequiredError` exportada de `src/portal/task-tracker.ts`:
   - `name === "WorkspaceRequiredError"`, propriedade `workspaces: string[]`.
   - Outros módulos detectam por `err?.name === "WorkspaceRequiredError"` e leem `(err as any).workspaces` (nunca `instanceof`, para os épicos compilarem independentes).
2. `POST /portal/tasks/create` body `{workspace?, parent_page_id?}`:
   - 400 `{error: "workspace_required", workspaces: string[]}` quando a conta tem >1 workspace e não veio `workspace` nem `parent_page_id`.
   - 201 `{data_source_id, url, title}` (inalterado) no sucesso.
3. `POST /portal/tasks/detect` body `{workspace?}`:
   - 200 `{status: "workspace_required", workspaces: string[], candidates: []}` quando ambíguo.
   - Demais shapes inalterados (`no-notion`, `none`, `one`, `many`).
4. `GET /portal/tasks/pages?q=...&workspace=...`: filtra a busca pelo workspace quando informado. Shape de resposta inalterado.
5. Tool MCP `zinom_setup_tasks` sem `workspace`/`pagina` em conta com >1 workspace responde `{ok:false, error:"workspace_required", workspaces:[...], message}` (o modelo pergunta à pessoa e re-chama com `workspace`).
6. `zinom_create_task` primeira-vez: conta com 1 workspace mantém auto-create; conta com >1 workspace responde `workspace_required` orientando usar `zinom_setup_tasks`.

---

## Épico 1 — Backend core (branch `feat/tasks-destino-backend`)

**Files:**
- Modify: `src/portal/task-tracker.ts` (resolveAccountNotion:57-68, createTaskTracker:168-246, detectTaskTracker:106-140)
- Modify: `src/portal/task-tracker-schema.ts` (novo helper puro `isZinomStandardSchema`)
- Modify: `src/portal/routes.ts:796-853` (detect/create/pages)
- Create: `src/portal/__tests__/task-tracker-destino.test.ts`
- Create: `docs/superpowers/plans/2026-06-12-tasks-onboarding-escolha-destino.md` (copiar este arquivo)

### Task 1.1: helper puro `isZinomStandardSchema`

- [ ] **Step 1: teste falhando** em `src/portal/__tests__/task-tracker-destino.test.ts`:

```ts
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
```

- [ ] **Step 2:** `node --import tsx --test src/portal/__tests__/task-tracker-destino.test.ts` → FAIL (export inexistente).
- [ ] **Step 3: implementação** em `src/portal/task-tracker-schema.ts` (depois de `findReusableTrackerId`):

```ts
/** Fingerprint do template padrão Zinom: além do título "Tarefas", a base
 *  precisa TER cara de template nosso ("Tipo" Fazer/Cobrar + "Tempo estimado
 *  (min)"). Evita adotar um board alheio que por acaso se chama "Tarefas"
 *  (causa do bug 2026-06-12: tracker apontado para o scrum da Global Cripto). */
export function isZinomStandardSchema(properties: NotionProps): boolean {
  if (!("Tempo estimado (min)" in (properties ?? {}))) return false;
  const tipo = (properties ?? {})["Tipo"];
  const opts = (tipo?.select?.options ?? []).map((o) => normalize(o.name ?? ""));
  return opts.includes("fazer") && opts.includes("cobrar");
}
```

- [ ] **Step 4:** rodar o teste → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(tasks): fingerprint do template Zinom p/ reuse-guard seguro"`

### Task 1.2: `WorkspaceRequiredError` + fim do `all[0]` silencioso

- [ ] **Step 1: teste falhando** (mesmo arquivo). `listAccountNotionTokens` do owner lê env; use ids de conta fake com seam: os fluxos de `detectTaskTracker` aceitam `fetchImpl`; para conta friend o vault exige DB. Então teste pelo caminho OWNER com env tokens fake:

```ts
import { detectTaskTracker, WorkspaceRequiredError } from "../task-tracker.js";

test("detect sem workspace com >1 token → status workspace_required", async (t) => {
  process.env.NOTION_PERSONAL_TOKEN = "tok-a";
  process.env.NOTION_GLOBALCRIPTO_TOKEN = "tok-b";
  t.after(() => { delete process.env.NOTION_PERSONAL_TOKEN; delete process.env.NOTION_GLOBALCRIPTO_TOKEN; });
  const r = await detectTaskTracker("bruno", { fetchImpl: (async () => { throw new Error("não deve chamar rede"); }) as any });
  assert.equal((r as any).status, "workspace_required");
  assert.deepEqual((r as any).workspaces, ["personal", "globalcripto"]);
});
```

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: implementação** em `src/portal/task-tracker.ts`:

```ts
/** Conta com mais de um Notion conectado precisa ESCOLHER onde agir. Detectada
 *  por `name` (não instanceof) nos outros módulos. */
export class WorkspaceRequiredError extends Error {
  readonly workspaces: string[];
  constructor(workspaces: string[]) {
    super(`escolha um workspace do Notion: ${workspaces.join(", ")}`);
    this.name = "WorkspaceRequiredError";
    this.workspaces = workspaces;
  }
}
```

`resolveAccountNotion` (substitui o `return all[0] ?? null`):

```ts
  if (all.length > 1) throw new WorkspaceRequiredError(all.map((t) => t.workspace));
  return all[0] ?? null;
```

`detectTaskTracker`: assinatura `opts: { fetchImpl?: typeof fetch; workspace?: string }`, passa `opts.workspace` para `resolveAccountNotion(accountId, opts.workspace)` e converte o throw em status:

```ts
export type DetectResult =
  | Detection
  | { status: "no-notion"; candidates: [] }
  | { status: "workspace_required"; workspaces: string[]; candidates: [] };

  let conn;
  try {
    conn = await resolveAccountNotion(accountId, opts.workspace);
  } catch (err: any) {
    if (err?.name === "WorkspaceRequiredError") {
      return { status: "workspace_required", workspaces: err.workspaces, candidates: [] };
    }
    throw err;
  }
```

`createTaskTracker`: deixa o throw subir (a rota responde 400). Nenhuma outra mudança de assinatura.

- [ ] **Step 4:** rodar testes do arquivo → PASS. Rodar `npm run build` → verde.
- [ ] **Step 5:** commit `"feat(tasks): workspace explícito obrigatório quando há mais de um Notion conectado"`

### Task 1.3: reuse-guard restrito ao template Zinom

- [ ] **Step 1: teste falhando**: simule `createTaskTracker("bruno", {workspace:"personal", fetchImpl})` com fetch fake: `/v1/search` devolve uma data source `{id:"ds-alheia", title:[{plain_text:"Tarefas"}]}`; `GET /v1/data_sources/ds-alheia` devolve schema SEM fingerprint; o fake registra chamadas. Espere: POST `/v1/pages` + POST `/v1/databases` acontecem (criou nova em vez de reusar). Obs: `setTasksDbId` exige Postgres/SECRETS_KEY — siga a convenção do repo de auto-skip: `const HAS_DB = !!process.env.POSTGRES_URL && !!process.env.SECRETS_KEY;` e `test("...", {skip: !HAS_DB}, ...)`. Se já existir um seam melhor nos testes vizinhos (procure por `__setPoolForTest` em `src/portal/__tests__/`), use-o.
- [ ] **Step 2:** rodar → FAIL (hoje reusa "ds-alheia").
- [ ] **Step 3: implementação** em `createTaskTracker` (substitui o bloco `findReusableTrackerId`): para cada hit com título normalizado igual a "Tarefas" (máx 3), `GET /v1/data_sources/{id}` e reuse APENAS se `isZinomStandardSchema(ds.properties)`:

```ts
    const titleHits = hits
      .filter((h) => h.title && h.title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
        === TARGET_DB_TITLE.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase())
      .slice(0, 3);
    let reuse: string | null = null;
    for (const h of titleHits) {
      try {
        const ds = await notionFetch(conn.token, `/v1/data_sources/${h.id}`, { method: "GET" }, fetchImpl);
        if (isZinomStandardSchema(ds?.properties ?? {})) { reuse = h.id; break; }
      } catch { /* candidata ilegível não é reuse */ }
    }
```

(Importar `isZinomStandardSchema` de `./task-tracker-schema.js`; manter o bloco de upgrade/invalidate existente quando `reuse` é truthy. `findReusableTrackerId` fica sem uso em task-tracker.ts: remova o import; mantenha a função e seus testes existentes se houver, ou remova ambos se nada mais a usa.)

- [ ] **Step 4:** testes do arquivo + `npm run build` → verdes.
- [ ] **Step 5:** commit `"fix(tasks): reuse-guard só adota base com fingerprint do template Zinom"`

### Task 1.4: rotas (detect body, create 400, pages workspace)

- [ ] **Step 1:** em `src/portal/routes.ts`:
  - detect (linha 797): ler `req.body?.workspace` (string opcional, trim) e passar: `detectTaskTracker(accountId, { workspace })` (mude `_req`→`req`).
  - create (linha 832-835): no catch, antes do 400 genérico:

```ts
      if (err?.name === "WorkspaceRequiredError") {
        res.status(400).json({ error: "workspace_required", workspaces: err.workspaces });
        return;
      }
```

  - pages (linha 839-848): ler `req.query.workspace` (string opcional) e passar `searchParentPages(accountId, q, { workspace })`.
- [ ] **Step 2:** `npm run build` verde; rodar a suíte inteira `npm test` → sem regressões (testes que cobriam o comportamento `all[0]`/reuse antigo: atualize a EXPECTATIVA para o contrato novo, nunca apague cobertura).
- [ ] **Step 3:** copiar este plano para `docs/superpowers/plans/2026-06-12-tasks-onboarding-escolha-destino.md`.
- [ ] **Step 4:** commit `"feat(portal): rotas de tasks com escolha explícita de workspace"`

---

## Épico 2 — Front do portal (branch `feat/tasks-destino-front`)

**Files:**
- Modify: `portal/app.js` (renderTasksCard:930-975; fluxos tasks:3532-3710)
- Modify: `portal/app.html` (card Tarefas, se precisar de markup novo)
- Modify (se necessário): `tests/e2e/*` que referencie os botões antigos

Regras: vanilla JS no padrão do arquivo (var, escapeHtml, _tasksMsg/_tasksActions escrevem em TODAS as superfícies via classe `.js-tasks-*`). Copy em pt-BR. Workspaces disponíveis vêm de `me.sources.notion.workspaces` (objetos `{workspace, name}`; ver app.js:797-820) — guarde em `window._me` no `load()` se ainda não estiver acessível.

### Task 2.1: seletor de workspace reutilizável

- [ ] **Step 1:** helper novo em app.js (perto dos helpers `_tasks*`):

```js
/* Lista de workspaces Notion conectados, para os fluxos de Tarefas. */
function _tasksWorkspaces() {
  var me = window._me || {};
  var s = me.sources || {};
  var ws = (s.notion && s.notion.workspaces) || [];
  return ws.map(function (w) { return { id: w.workspace || w.name, name: w.name || w.workspace }; });
}

/* Render de um <select> de workspace quando há mais de um; callback recebe o id. */
function _tasksWorkspacePickerHtml(selectedId) {
  var ws = _tasksWorkspaces();
  if (ws.length <= 1) return '';
  return '<select class="js-tasks-ws" aria-label="Workspace do Notion" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">' +
    ws.map(function (w) {
      return '<option value="' + escapeHtml(w.id) + '"' + (w.id === selectedId ? ' selected' : '') + '>' + escapeHtml(w.name) + '</option>';
    }).join('') + '</select> ';
}
function _tasksSelectedWorkspace(scopeEl) {
  var sel = (scopeEl || document).querySelector('.js-tasks-ws');
  if (sel && sel.value) return sel.value;
  var ws = _tasksWorkspaces();
  return ws.length === 1 ? ws[0].id : undefined;
}
```

- [ ] **Step 2:** commit `"feat(portal-ui): seletor de workspace para fluxos de Tarefas"`

### Task 2.2: fluxo "Escolher onde criar" vira o primário (estado não-configurado)

- [ ] **Step 1:** em `renderTasksCard` (estado não-configurado, app.js:967-974), reordene e renomeie:

```js
  _tasksMsg('Escolha em qual workspace e página o seu Gestor de Tarefas (template Zinom) deve nascer. Depois dá para migrar tarefas antigas pedindo ao Zinom.');
  _tasksActions(
    '<button class="btn btn-primary btn-sm" type="button" data-tasks-choose>Escolher onde criar (recomendado)</button>' +
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar no topo do workspace</button>' +
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Já tenho uma base no Notion</button>'
  );
```

- [ ] **Step 2:** `runChooseTasks` ganha o seletor de workspace e a busca passa o workspace:

```js
function runChooseTasks() {
  _tasksMsgHtml(
    'Onde a base "Tarefas" deve nascer? ' + _tasksWorkspacePickerHtml() +
    '<input type="text" class="js-tasks-page-q" placeholder="Nome da página (ex.: Projetos)" ' +
      'style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;max-width:220px" ' +
      'aria-label="Nome da página no Notion"> ' +
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-search>Buscar</button>' +
    '<span class="js-tasks-pick-results"></span>'
  );
}
```

  Em `runSearchTasksPages`, inclua `&workspace=` quando houver seleção:

```js
    var ws = _tasksSelectedWorkspace(wrap);
    res = await api('/portal/tasks/pages?q=' + encodeURIComponent(q) + (ws ? '&workspace=' + encodeURIComponent(ws) : ''));
```

- [ ] **Step 3:** `runCreateTasks` (topo do workspace) envia workspace e trata `workspace_required`:

```js
async function runCreateTasks(workspace) {
  _tasksMsg('Criando a página "🧠 Zinom" no topo do seu workspace do Notion, com a base "Tarefas" dentro…');
  _tasksActions('');
  var res;
  try {
    res = await apiJSON('/portal/tasks/create', 'POST', workspace ? { workspace: workspace } : {});
  } catch (e) { _tasksMsg('Erro de rede. Tente novamente.'); return; }
  if (res.ok) { load(); return; }
  var b = await res.json().catch(function () { return {}; });
  if (b && b.error === 'workspace_required') {
    _tasksMsgHtml('Em qual workspace? ' + _tasksWorkspacePickerHtml() +
      '<button class="btn btn-primary btn-sm" type="button" data-tasks-create-ws>Criar aqui</button>');
    return;
  }
  _tasksMsg(b.error || 'Nao consegui criar. Tente configurar o token (PAT) em Fontes.');
}
```

  No delegated click handler (procure onde `data-tasks-create` é tratado), adicione `data-tasks-create-ws` → `runCreateTasks(_tasksSelectedWorkspace(document))`.
- [ ] **Step 4:** `runDetectTasks` envia `{workspace}` quando houver seleção e trata `status === 'workspace_required'` mostrando o seletor + botão "Buscar neste workspace" (re-chama com o workspace escolhido).
- [ ] **Step 5:** teste manual mínimo por máquina: `npm run build` (o build não toca o front, mas garante nada quebrou) e, se o ambiente local tiver Postgres, `npm run dev:portal` + `npx playwright test` nos specs de tasks. Se Playwright não rodar localmente, registre no PR que a verificação ficou no CI + smoke pós-deploy.
- [ ] **Step 6:** commit `"feat(portal-ui): escolha de workspace e página como fluxo primário de criação"`

### Task 2.3: estado configurado ganha "Trocar de base…" completo

- [ ] **Step 1:** em `renderTasksCard` (estado configurado, app.js:958-963), troque as ações por:

```js
    _tasksActions(
      (isHttpUrl(info.url)
        ? '<a class="btn btn-primary btn-sm" href="' + escapeHtml(info.url) + '" target="_blank" rel="noopener">Abrir no Notion ↗</a> '
        : '') +
      '<button class="btn btn-ghost btn-sm" type="button" data-tasks-switch>Trocar de base…</button>'
    );
```

- [ ] **Step 2:** novo `runSwitchTasks()` (handler de `data-tasks-switch`): mostra aviso + as TRÊS opções do estado não-configurado:

```js
function runSwitchTasks() {
  _tasksMsg('A base atual continua no seu Notion; as tarefas não migram automaticamente (peça ao Zinom depois, se quiser).');
  _tasksActions(
    '<button class="btn btn-primary btn-sm" type="button" data-tasks-choose>Criar em outro lugar…</button>' +
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Apontar uma base existente</button>'
  );
}
```

- [ ] **Step 3:** e2e: ajuste qualquer spec em `tests/e2e/` que dependa do botão antigo "Trocar de base" (`data-tasks-detect` direto no estado configurado).
- [ ] **Step 4:** commit `"feat(portal-ui): trocar de base com escolha de destino no estado configurado"`

---

## Épico 3 — Tools MCP (branch `feat/tasks-destino-mcp`)

**Files:**
- Modify: `src/zinom-tasks-tools.ts` (taskError:44-55, SetupTasksDeps:59-77, setupTasksFlow:83-161, descrições das tools, wiring:279-287)
- Create: `src/portal/__tests__/setup-tasks-flow-destino.test.ts`

NÃO importe nada novo de `./portal/task-tracker.js` além do que já existe (`listAccountNotionTokens` JÁ é exportada hoje). Detecte o erro do Épico 1 por `err?.name === "WorkspaceRequiredError"`.

### Task 3.1: `setupTasksFlow` pede workspace quando ambíguo

- [ ] **Step 1: teste falhando** em `src/portal/__tests__/setup-tasks-flow-destino.test.ts` (núcleo puro, deps fake, sem rede/DB):

```ts
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
```

- [ ] **Step 2:** rodar → FAIL (`listWorkspaces` não existe em `SetupTasksDeps`).
- [ ] **Step 3: implementação:** adicionar a `SetupTasksDeps`:

```ts
  listWorkspaces: (accountId: string) => Promise<string[]>;
```

  Em `setupTasksFlow`, logo APÓS o bloco de `pagina` (linha 142) e ANTES do `createTaskTracker`:

```ts
  if (!targetWorkspace && !parentPageId) {
    const ws = await deps.listWorkspaces(accountId);
    if (ws.length > 1) {
      return {
        ok: false,
        error: "workspace_required",
        workspaces: ws,
        message:
          "Você tem mais de um Notion conectado. Em qual workspace devo criar a base de Tarefas? " +
          `Opções: ${ws.join(", ")}. Me diga e eu chamo de novo com esse workspace (e, se quiser, a página).`,
      };
    }
  }
```

  No handler da tool (linha 279-287), wire:

```ts
          listWorkspaces: async (a) => (await tracker.listAccountNotionTokens(a)).map((t) => t.workspace),
```

- [ ] **Step 4:** rodar os testes do arquivo → PASS. `npm run build` → verde.
- [ ] **Step 5:** commit `"feat(mcp): zinom_setup_tasks pergunta o workspace quando há mais de um Notion"`

### Task 3.2: `taskError` mapeia `workspace_required` (cobre o auto-create do zinom_create_task)

Contexto: `createTask` (src/tasks/write.ts:262-272) auto-cria a base na primeira tarefa chamando `createTaskTracker` SEM workspace; com o Épico 1, contas multi-workspace agora lançam `WorkspaceRequiredError`, que sobe até `taskError`. Não mexa em write.ts.

- [ ] **Step 1: teste falhando** (mesmo arquivo de teste; `taskError` não é exportada — teste pelo comportamento via `setupTasksFlow`? Não: `taskError` é usada pelos handlers. Exporte-a para teste):

```ts
import { taskError } from "../../zinom-tasks-tools.js";

test("taskError: WorkspaceRequiredError vira workspace_required com a lista", () => {
  const err = Object.assign(new Error("escolha um workspace"), {
    name: "WorkspaceRequiredError",
    workspaces: ["personal", "globalcripto"],
  });
  const out = JSON.parse((taskError(err) as any).content[0].text);
  assert.equal(out.error, "workspace_required");
  assert.match(out.message, /personal/);
});
```

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** exportar `taskError` (trocar `function taskError` por `export function taskError`) e adicionar o branch ANTES do genérico:

```ts
  if (e instanceof Error && e.name === "WorkspaceRequiredError") {
    const ws = ((e as any).workspaces as string[]) ?? [];
    return fail(
      "workspace_required",
      `Você tem mais de um Notion conectado (${ws.join(", ")}). Use zinom_setup_tasks com o workspace (e página, se quiser) onde a base de Tarefas deve nascer.`,
    );
  }
```

- [ ] **Step 4:** PASS + `npm run build` verde.
- [ ] **Step 5:** atualizar as DESCRIÇÕES das tools: em `zinom_setup_tasks`, documentar que sem `workspace` em conta multi-Notion a resposta é `workspace_required` com as opções (mostre-as à pessoa); em `zinom_create_task`, trocar a frase "o Zinom cria a padrão automaticamente na primeira vez" por "com um único Notion conectado o Zinom cria a base padrão automaticamente; com mais de um, ele pergunta o workspace (zinom_setup_tasks)". Atualizar `NO_TRACKER_MSG` para citar a escolha de workspace/página.
- [ ] **Step 6:** rodar `npm test` inteiro → sem regressões. Commit `"feat(mcp): primeira tarefa em conta multi-workspace pede destino em vez de criar às cegas"`

---

## Integração (orquestrador)

1. Merge dos 3 branches em `feat/tasks-destino` (ordem: backend → mcp → front), resolver conflitos (não deve haver: arquivos disjuntos).
2. `npm ci && npm run build && npm test` no worktree de integração.
3. PR único via skill `zinom-pr`, CI `build-test` verde, merge.
4. Deploy via skill `zinom-deploy` + verificação 401/health.
5. Validação funcional da conta do Bruno: portal → Tarefas → "Trocar de base…" → "Apontar uma base existente" → workspace pessoal → usar "Tasks Tracker" (isto corrige a conta dele pela UI, sem SSH).

## Self-review (feito na escrita)

- Cobertura do spec: escolha de workspace+página no onboarding (Tasks 2.1/2.2, 1.2/1.4), sem varrer o Notion todo (detect por workspace + reuse-guard com no máx. 3 GETs, Task 1.3), trocar base depois (Task 2.3), MCP coerente (Épico 3), migração fora de escopo (documentado).
- Tipos consistentes: `WorkspaceRequiredError.workspaces: string[]`; contrato por `err.name`; `SetupTasksDeps.listWorkspaces` casa com o wiring.
- Sem placeholders: todo step de código tem o código.
