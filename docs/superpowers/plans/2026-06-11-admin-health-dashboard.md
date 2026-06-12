# Painel de Saúde do Sistema — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seção **Sistema** no `/admin` com saúde de VPS, PM2, Postgres, entrada pública, APIs parceiras e orçamento de IA, com histórico de 7 dias, sparklines e alertas ntfy.

**Architecture:** Collector interno (`node-cron`, processo `notion-mcp`) roda probes em paralelo e grava em `health_samples` (Postgres). O admin lê a última amostra por check + séries de 24h e renderiza server-side no padrão existente; `/admin/health.json` alimenta auto-refresh. Alertas em transição de estado reusam `notify()` (ntfy).

**Tech Stack:** TypeScript/Express, pg, node-cron (já existentes), SVG puro para sparklines, node:test via tsx, Playwright. **Zero dependências novas.**

**Spec:** `docs/superpowers/specs/2026-06-11-admin-health-dashboard-design.md`

---

## Orquestração (ondas, agentes e modelos)

Execução por agentes paralelos **no mesmo worktree** (`.claude/worktrees/admin-health`), com
propriedade disjunta de arquivos por tarefa — em vez de um worktree por agente — porque os
módulos são arquivos novos sem sobreposição; isso elimina o custo de merge entre worktrees.
Regras para TODO agente:

1. **Não rode nenhum comando git** (sem add/commit/push). O orquestrador commita.
2. **Só toque nos arquivos listados como seus.** Conflito de arquivo = bug de orquestração.
3. TDD: escreva o teste, veja falhar, implemente, veja passar. Rode **só o seu** arquivo de
   teste: `npx tsx --test src/health/__tests__/<seu>.test.ts`.
4. Siga os padrões do repo (fetch injetável tipo `src/notify.ts`, helpers puros testáveis
   tipo `src/rag/status.ts`, erro explícito, pt-BR nos rótulos).

| Onda | Tarefa | Arquivos novos/modificados | Executor | Modelo |
|---|---|---|---|---|
| 0 | T0 Skeleton: migration, tipos, storage, collector stub, wiring | `scripts/migrations/0017_health_samples.sql`, `src/health/{types,storage,collector,alerts}.ts`, `src/index.ts`, `package.json` | orquestrador | fable |
| 1 | TA Probes locais | `src/health/probes-local.ts`, `src/health/__tests__/probes-local.test.ts` | agente A | sonnet |
| 1 | TB Probes externos | `src/health/probes-external.ts`, `src/health/__tests__/probes-external.test.ts` | agente B | sonnet |
| 1 | TC Orçamento IA | `src/health/budgets.ts`, `src/health/__tests__/budgets.test.ts` | agente C | sonnet |
| 1 | TE Alertas + docs | `src/health/alerts.ts` (reescreve stub), `src/health/storage.ts` (+1 função), `src/health/__tests__/alerts.test.ts`, `docs/RUNBOOK.md`, `CLAUDE.md` | agente E | sonnet |
| 2 | TD UI admin + endpoints + e2e | `src/admin/system-section.ts`, `src/admin/sparkline.ts`, `src/admin/routes.ts`, `src/admin/__tests__/sparkline.test.ts`, `scripts/admin-preview.ts`, `tests/e2e/admin-ui.spec.ts` | agente D | opus |
| 3 | TF Integração, PR, deploy | `src/index.ts` (registro dos probes), build+test+e2e, PR, merge, deploy | orquestrador | fable |

Onda 1 é 4 agentes em paralelo (TA, TB, TC, TE). TD depende dos tipos (T0) e dos shapes de
`detail` (TA/TB/TC), então roda na onda 2. Modelos: sonnet para módulos mecânicos bem
especificados; opus para a UI (superfície grande, sensível a design); fable (orquestrador)
para contratos e integração.

---

## Mapa de responsabilidades

- `src/health/types.ts` — contrato `CheckResult`/`Probe` + `worstStatus()` (puro).
- `src/health/storage.ts` — shell fino de SQL: insert/latest/series/prune/samplesToday.
- `src/health/collector.ts` — registry de probes, lock, orquestra coleta→alerta→prune, cron.
- `src/health/probes-local.ts` — vps, postgres, pm2 (avaliadores puros + wrappers finos).
- `src/health/probes-external.ts` — notion, anthropic, voyage, resend, stripe, proxy, ntfy.
- `src/health/budgets.ts` — gasto vs orçamento (anthropic real, voyage estimado, tokens LLM).
- `src/health/alerts.ts` — transições e limiares → `notify()`.
- `src/admin/sparkline.ts` + `src/admin/system-section.ts` — renderização pura da seção.
- `src/admin/routes.ts` — só TD toca: gather() + nav + seção + 2 rotas novas.

---

### T0 (orquestrador): skeleton e contratos

**Files:** Create `scripts/migrations/0017_health_samples.sql`, `src/health/types.ts`,
`src/health/storage.ts`, `src/health/collector.ts`, `src/health/alerts.ts` (stub),
`src/health/__tests__/types.test.ts`. Modify `package.json` (glob de teste), `src/index.ts`.

- [ ] **0.1 Migration** — conteúdo exato do spec (tabela `health_samples` + índice
  `(check_id, ts DESC)`).
- [ ] **0.2 `types.ts`** — contrato do spec, mais:

```ts
const ORDER: Record<HealthStatus, number> = { fail: 3, warn: 2, ok: 1, skip: 0 };
/** Pior estado entre os checks; tudo-skip → "skip"; lista vazia → "skip". */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((w, s) => (ORDER[s] > ORDER[w] ? s : w), "skip");
}
```

- [ ] **0.3 Teste de `worstStatus`** em `src/health/__tests__/types.test.ts` (node:test,
  casos: vazio→skip, [ok]→ok, [ok,warn]→warn, [warn,fail,ok]→fail, [skip,skip]→skip).
  Adicionar `src/health/__tests__/*.test.ts` ao glob de `npm test` no `package.json`.
- [ ] **0.4 `storage.ts`** — funções (shell fino, sem teste unitário, padrão do repo):
  `insertSamples(results, now)`, `latestSamples(): Promise<SampleRow[]>` (DISTINCT ON),
  `latestStatuses(): Promise<Map<string, HealthStatus>>`, `seriesSince(hours, now)`,
  `pruneSamples(days, now)`. `label` e `group` são gravados dentro de `detail` para a UI
  ler sem registry. `error` truncado a 200 chars no insert.
- [ ] **0.5 `collector.ts`** — `registerProbe(p)`, `runHealthCollection(now?)` com lock em
  memória (`running`), `Promise.allSettled`, fluxo prev→insert→alerts→prune,
  `startHealthCollector()` com `HEALTH_CRON` (default `*/5 * * * *`, `off` desliga) +
  coleta inicial após 30s.
- [ ] **0.6 `alerts.ts` stub** — `export async function dispatchHealthAlerts(_prev, _results, _now) {}` (TE reescreve).
- [ ] **0.7 Wiring `index.ts`** — `if (process.env.POSTGRES_URL) startHealthCollector();`
  junto da subida do servidor (sem registro de probes ainda — TF registra).
- [ ] **0.8 Verificar** `npm run build` e `npx tsx --test src/health/__tests__/types.test.ts`
  verdes. Commit: `feat(health): skeleton do collector de saúde (migration, tipos, storage)`.

---

### TA (agente A, sonnet): probes locais

**Files:** Create `src/health/probes-local.ts`, `src/health/__tests__/probes-local.test.ts`.

Avaliadores **puros** (testados) + wrappers finos que coletam números do SO/DB:

```ts
export interface VpsNumbers { load1: number; cores: number; memPct: number; diskPct: number | null; uptimeSec: number }
export function evalVps(n: VpsNumbers): CheckResult;       // warn: disk>80, mem>85, load1>cores; fail: disk>92, mem>95
export function parsePm2Jlist(json: string, expected: string[]): CheckResult;
export async function vpsProbe(): Promise<CheckResult[]>;   // os.loadavg/cpus/uptime, /proc/meminfo (MemAvailable) com fallback os.freemem, fs.promises.statfs("/") com fallback diskPct=null
export async function pm2Probe(exec?: ExecFileFn): Promise<CheckResult[]>; // execFile("pm2", ["jlist"], timeout 5s); ENOENT → skip ("pm2 não disponível")
export async function postgresProbe(): Promise<CheckResult[]>; // SELECT 1 (latência), pg_database_size(current_database()), numbackends; erro → fail
```

Regras de `parsePm2Jlist` (testar todas): processos esperados `notion-mcp`, `brain-indexer`,
`brain-classifier` precisam estar `online` (qualquer outro estado → fail);
`brain-reindex-nightly` é cron com `autorestart:false` — `stopped` é **normal** (ok);
processo esperado ausente da lista → fail; `detail` carrega por processo
`{status, restarts, memMb}`. JSON inválido → fail com erro truncado.

Casos de teste mínimos: evalVps ok/warn-disco/warn-mem/warn-load/fail-disco/fail-mem e
diskPct null (não opina sobre disco); parsePm2Jlist todos acima; pm2Probe com exec fake
ENOENT → skip. `detail` do vps: `{load1, load5, load15, cores, memPct, diskPct, uptimeSec}`.

- [ ] Teste primeiro (ver falhar) → implementar → `npx tsx --test src/health/__tests__/probes-local.test.ts` verde.

---

### TB (agente B, sonnet): probes externos

**Files:** Create `src/health/probes-external.ts`, `src/health/__tests__/probes-external.test.ts`.

Padrão: fetch injetável (como `src/notify.ts`), `AbortSignal.timeout(8000)`, latência medida,
não-2xx → fail com `HTTP <status>` (sem corpo no erro), credencial ausente → skip.

```ts
export function makeExternalProbes(f: typeof fetch = fetch): Probe[];
```

| checkId | request | ok quando | observações |
|---|---|---|---|
| `notion:personal\|globalcripto\|nora` | `GET https://api.notion.com/v1/users/me` com `Notion-Version` igual a `NOTION_API_VERSION` de `src/clients.ts` e token da env do workspace | 200 | um check por workspace com token configurado; sem token → skip |
| `anthropic` | `GET https://api.anthropic.com/v1/models` com `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01` | 200 | |
| `voyage` | `POST` em `process.env.VOYAGE_EMBEDDINGS_URL ?? "https://api.voyageai.com/v1/embeddings"` body `{input:["ping"],model:"voyage-3-large"}` | 200 | **usar o env override** — a VPS roteia Voyage por egress IPv6 (`src/rag/embeddings.ts:8`) |
| `resend` | `GET https://api.resend.com/domains` Bearer `RESEND_API_KEY` | 200 | |
| `stripe` | `GET https://api.stripe.com/v1/balance` Bearer `STRIPE_SECRET_KEY` | 200 | `detail`: available/pending por moeda (centavos) |
| `proxy_publico` | `GET process.env.HEALTH_PUBLIC_URL ?? "https://zinom.ai/mcp"` **sem** auth | status **=== 401** | 200/404/timeout → fail ("proxy quebrou") — 401 é o estado saudável |
| `ntfy` | `HEAD NTFY_URL` | 2xx | sem `NTFY_URL` → skip |

Testes com fetch fake (Response canned): 200→ok com latência, 500→fail, 401 em
`proxy_publico`→ok, 404 em `proxy_publico`→fail, env ausente→skip, exceção/abort→fail.

- [ ] Teste primeiro → implementar → teste verde.

---

### TC (agente C, sonnet): orçamento de IA

**Files:** Create `src/health/budgets.ts`, `src/health/__tests__/budgets.test.ts`.

```ts
export function evalBudget(spentUsd: number, budgetUsd: number | undefined): HealthStatus;
// sem orçamento → ok (informacional); pct>=100 → fail; >=80 → warn; senão ok
export async function anthropicBudgetCheck(getReport = getOrgCostReport): Promise<CheckResult[]>;
// "budget:anthropic": gasto MTD real via summariseCostReport(report).totalUsdCents/100
// vs HEALTH_BUDGET_ANTHROPIC_USD; sem ANTHROPIC_ADMIN_KEY (report null) → skip
export async function voyageBudgetCheck(): Promise<CheckResult[]>;
// "budget:voyage": SUM(qty) de usage_log metric='embed_tokens' desde monthStartUTC()
// × COST_EMBED_PER_MTOK/1e6 vs HEALTH_BUDGET_VOYAGE_USD; sem COST_EMBED_PER_MTOK → skip
export async function llmTokensCheck(): Promise<CheckResult[]>;
// "tokens:llm": SUM llm_input_tokens / llm_output_tokens MTD; sempre ok (informacional)
```

`detail` padronizado: `{spentUsd, budgetUsd, pct}` (budget) / `{inTokens, outTokens}` (tokens).
Reusar `getOrgCostReport` (`src/admin/anthropic-cost.ts`), `summariseCostReport`
(`src/admin/business.ts`), `monthStartUTC` (`src/billing/usage.ts`), `getPool`.
Testes: evalBudget nos limiares exatos (79.9/80/99.9/100, sem orçamento), anthropicBudgetCheck
com getReport fake (null → skip; report fixture → spentUsd correto).

- [ ] Teste primeiro → implementar → teste verde.

---

### TE (agente E, sonnet): alertas + docs

**Files:** Rewrite `src/health/alerts.ts`; Modify `src/health/storage.ts` (adicionar
`samplesToday(checkIds: string[], now: Date): Promise<SampleRow[]>` — amostras de hoje UTC,
ts < now), `docs/RUNBOOK.md`, `CLAUDE.md`; Create `src/health/__tests__/alerts.test.ts`.

```ts
export interface HealthAlert { message: string; priority: "default" | "high" }
export function computeTransitionAlerts(prev: Map<string, HealthStatus>, results: CheckResult[]): HealthAlert[];
// ok|warn → fail: high "✗ <label> falhou: <erro>"; fail → ok: default "✓ <label> recuperou";
// ignora checks "budget:*" e quaisquer skip (antes ou depois); check sem prev nunca alerta
export function computeBudgetAlerts(results: CheckResult[], todaysEarlier: SampleRow[]): HealthAlert[];
// só "budget:*": warn sem nenhum warn/fail anterior hoje → high "⚠ <label> passou de 80%…";
// fail sem nenhum fail anterior hoje → high "✗ <label> estourou o orçamento…"
export async function dispatchHealthAlerts(prev, results, now): Promise<void>;
// samplesToday p/ budget:* → compõe os dois → notify() um a um; falha de notify não propaga
```

Testes (puros, sem DB): transição ok→fail alerta; fail→fail não; fail→ok recupera; skip
nunca; budget warn duas vezes no mesmo dia alerta uma; budget fail após warn no dia alerta
(limiar diferente).

Docs: seção "Painel de saúde (admin → Sistema)" no `docs/RUNBOOK.md` (o que cada estado
significa, como rodar coleta manual, envs novas) e as 4 envs novas na seção "Environment
variables" do `CLAUDE.md` (`HEALTH_CRON`, `HEALTH_PUBLIC_URL`, `HEALTH_BUDGET_ANTHROPIC_USD`,
`HEALTH_BUDGET_VOYAGE_USD`).

- [ ] Teste primeiro → implementar → `npx tsx --test src/health/__tests__/alerts.test.ts` verde.

---

### TD (agente D, opus): seção Sistema no admin

**Files:** Create `src/admin/system-section.ts`, `src/admin/sparkline.ts`,
`src/admin/__tests__/sparkline.test.ts`. Modify `src/admin/routes.ts`,
`scripts/admin-preview.ts`, `tests/e2e/admin-ui.spec.ts`.

- [ ] **D.1 `sparkline.ts`** — `renderSparkline(points: number[], opts?: {w?: number; h?: number; cls?: string}): string`
  (polyline SVG normalizada, vazio → SVG vazio, 1 ponto → linha plana, NaN filtrado).
  Teste unitário primeiro (node:test): contém `<svg`, `points=` com N pares, vazio sem polyline.
- [ ] **D.2 `system-section.ts`** — `renderSystemSection(h: HealthView, token: string): string`
  puro, sem DB (padrão `renderStatusHtml`). `HealthView` = `{ collectedAt: string | null;
  checks: SampleRow[]; series: Map<string, number[]> }` (séries de latência/gauge por check,
  24h). Layout: card grande de estado agregado (`worstStatus`) + botão "Atualizar agora"
  (POST `/admin/health/run`); grid de tiles por grupo (vps com gauges disco/mem/load,
  processos, banco, entrada, parceiros com sparkline de latência, créditos com barra de
  orçamento estilo `.funnel-track`). Ponto de status: ok=`var(--accent)`, warn=`#c98a00`,
  fail=`#b3261e`, skip=`var(--muted)`. Cada tile com `data-check="<checkId>"` e valores em
  elementos com `data-field` para o refresh JS. Sem amostra nenhuma → estado vazio amigável
  ("collector ainda não rodou").
- [ ] **D.3 `routes.ts`** — (a) `gather()` inclui `health` via `latestSamples()` +
  `seriesSince(24)` (falha → `{collectedAt:null, checks:[], series:new Map()}` graceful);
  (b) nav: "Sistema" primeiro no sidebar + tabbar, `#sistema` vira view default do router
  inline (fallback `'resumo'`→`'sistema'`, adicionar `'sistema'` ao array VIEWS);
  (c) `${renderSystemSection(...)}` antes de RESUMO; (d) `GET /admin/health.json` (mesma
  gate): `{overall, collectedAt, checks}`; (e) `POST /admin/health/run` (gate) →
  `runHealthCollection()` → redirect `/admin?token=…&msg=Coleta executada.#sistema`;
  (f) script inline: `setInterval` 60s fetch de `health.json` atualizando
  `[data-check]`/`[data-field]` e classes de status (só quando a view sistema está ativa).
- [ ] **D.4 Fixture** — `scripts/admin-preview.ts` ganha `health` representativo (ok, warn
  com disco 87%, fail notion com erro, skip ntfy, budget 85%) e séries sintéticas
  determinísticas (sem `Math.random`).
- [ ] **D.5 Playwright** — em `tests/e2e/admin-ui.spec.ts`: `#sistema` visível por default,
  contém tile `[data-check="vps"]`, um `.tag`/dot de fail visível para o check com erro do
  fixture, barra de orçamento presente. Rodar: `npx playwright test tests/e2e/admin-ui.spec.ts`.
- [ ] **D.6** `npm run build` + `npx tsx --test src/admin/__tests__/sparkline.test.ts` verdes.

---

### TF (orquestrador): integração, PR, deploy

- [ ] **F.1** Registrar probes no `index.ts` (após T A/B/C prontos):
  `[vpsProbe, pm2Probe, postgresProbe, ...makeExternalProbes(), anthropicBudgetCheck, voyageBudgetCheck, llmTokensCheck].forEach(registerProbe)`.
- [ ] **F.2** Revisão de integração (shapes de `detail` vs UI), `npm run build`, `npm test`,
  `npx playwright test` — tudo verde. Commits atômicos por módulo.
- [ ] **F.3** Push branch, PR via API GitHub (token de `git credential fill`), CI
  `build-test` verde, merge.
- [ ] **F.4** Deploy rotineiro pré-autorizado (inclui `npm run migrate`) e verificação:
  `/health` 200, `/status` sem stale_or_failing, `/admin?token` contém `id="sistema"`,
  `/admin/health.json` retorna `overall`, `https://zinom.ai/mcp` → 401.

## Self-review do plano

- Cobertura do spec: painéis 1–8 → TD; checks → TA/TB/TC; modelo de dados/collector → T0;
  alertas → TE; envs/docs → TE; critérios de aceite → TF. Sem lacunas.
- Sem placeholders; contratos de tipos definidos em T0 e referenciados consistentemente
  (`CheckResult`, `SampleRow`, `worstStatus`, `runHealthCollection`).
- Riscos anotados: `fs.statfs` requer Node ≥18.15 (fallback null); pm2 ausente em dev
  (skip); nightly `stopped` é saudável; Voyage só via env override.
