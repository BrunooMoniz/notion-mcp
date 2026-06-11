# Fase 3 — Billing + Freemium (planos pagos + limites reais) — Design (spec dedicado)

**Data:** 2026-06-06
**Autor:** Bruno + agente (Conductor)
**Repo de planejamento:** `BrunooMoniz/mcp-notion` (este repo — só docs)
**Repo de implementação:** `BrunooMoniz/notion-mcp` (código real, deploy PM2 na VPS; working copy em `.context/notion-mcp`, branch `main`, HEAD = merge do PR #36 account-portal)
**Origem:** O spec da Fase 3 (`2026-06-05-fase3-freemium-design.md`) adiou billing de propósito: *"P5 — Billing: deferido — só metering agora; cobrança depois (Stripe simples), fora do MVP da Fase 3"* e *"Billing (P5) fica pra um spec futuro"*. **Este é esse spec futuro.** Cobre F3.3 (limites/enforcement) + billing Stripe + cadastro/funil + UI do app. Baseado num mapa read-only do código atual (2026-06-06).

---

## 0. Decisões travadas (confirmadas pelo Bruno em 2026-06-06)

| # | Decisão | Travado |
|---|---|---|
| C1 | **Moeda** | **BRL (R$)** |
| C2 | **Matriz de planos** (Free + 3 pagos, nomes e limites) | **Aprovada como na §3** |
| C3 | **Stripe** | **Produção direto** (conta real). Integração **hospedada** (Checkout + Customer Portal da Stripe, sem dado de cartão no nosso server). Dev/CI **não** tocam a chave live: testes com Stripe mockado + modo teste **da mesma conta** (chave `*_test`) pra verificar a UX antes de abrir; chave **live** só no `.env` da VPS, smoke test real com ok do Bruno no go-live. |
| C4 | **Cadastro Free** | **Apenas com convite** (fluxo invite-only atual, inalterado) |
| C5 | **Funil pago** (inferido, conservador — veta se errado) | Entrada = convite (Free). **Upgrade pros pagos = self-serve dentro do app** (Checkout). Entrada paga pública **sem** convite fica pra LP (deferida). O motor de billing já suporta as duas; a LP só pluga um botão público depois. |

> **Gate de deploy (inegociável, herdado do plano F3):** mudanças no caminho de isolamento (qualquer coisa que toque `buildFilterClauses`/`brainSearch`/`account_id`) e a **chave live da Stripe** vão pra prod **só após ok explícito do Bruno**. Construo, testo (TDD), review adversarial de isolamento + segurança, CI verde; seguro o deploy até o ok.

---

## 1. Visão

O Zinom (`notion-mcp`) já é multi-tenant: `account_id` em tudo, contas, vault cifrado, tokens de API por conta, portal de cadastro (convite + magic-link), e **metering passivo** (`usage_log` registra `search`/`embed_tokens`/`chunks`, sem bloquear nada). **Não existe** noção de plano, limite com enforcement, nem cobrança.

Esta fase entrega o **freemium de verdade**: um plano **Free** com tetos que protegem a margem, e **3 planos pagos** (R$4,99 / R$9,99 / R$18,99/mês) que liberam mais cota e mais features, com **cobrança via Stripe** e **UI no app** (cadastro continua por convite; upgrade/gerência de assinatura self-serve dentro do app).

**Escopo deste spec:** backend + front **do aplicativo** (portal `/app.html` + admin). **Fora de escopo:** LP pública, página de comparação de planos, marketing (o Bruno disse explicitamente: "as mudanças da LP e comparações de planos será feito depois").

---

## 2. Estado atual relevante (do mapa de 2026-06-06)

- **Conta:** `account(id, kind, status, email, created_at)`. `kind` ∈ {`owner` (bruno), `friend`}. **Sem coluna de plano/billing.** (`0005`, `0007`)
- **Isolamento:** toda leitura filtra `account_id` (do `RequestContext`, nunca de input) + guard de workspace. `getAccountId()` default `'bruno'`. **Não pode regredir.** (`context.ts`, `storage.ts buildFilterClauses`)
- **Metering passivo (best-effort, nunca bloqueia):** `recordUsage(accountId, metric, qty)` → `usage_log(account_id, metric, qty, ts)`. Métricas: `search` (1/busca, `search.ts:265`), `embed_tokens` (tokens Voyage na indexação, `embeddings.ts:113`), `chunks` (`storage.ts:85`). **Não metrificado:** tokens do query-embedding e rerank. Toggle `METERING_ENABLED`. Admin lê `SELECT account_id, metric, sum(qty) GROUP BY` (sem janela temporal). (`usage.ts`, `admin/routes.ts:32`)
- **Cadastro (invite-only):** `/portal/request-invite` (lead) → operador `/admin/invite` (gera código, e-mail) → `/portal/register {email, code}` (redime + cria conta atômico) → magic-link → `/portal/verify` → cookie de sessão → `/app.html`. (`portal/routes.ts`, `portal/accounts.ts`)
- **Portal app (`/app.html` + `app.js`):** mostra fontes (Notion/Granola/iCal), botões de credencial, gera token MCP, reindex. HTML/CSS/JS vanilla servidos do disco (`portal/`).
- **Admin (`/admin`):** dashboard server-rendered, bearer-gated. Contas, leads, fontes, uso.
- **Features que variam em custo/valor:** nº de workspaces Notion conectados; `brain_search` (top_k ≤ 50); indexação on-demand `brain_index_url`/`brain_index_web` (max_pages ≤ 200); reindex (re-embed completo); indexer/classifier/revisitar/granola/calendar (cron); briefing diário.
- **Drivers de custo (COGS):** embeddings Voyage (indexação + query), rerank Voyage, storage no pgvector (RAM da VPS é o teto físico), e classifier (Anthropic) se ligado por conta.

---

## 3. Modelo de planos (travado — C2)

Owner (`bruno`) = **ilimitado** (sentinela de plano `owner`, nunca bloqueado). Os 4 planos de produto:

| Alavanca | **Free** R$0 | **Essencial** R$4,99 | **Pro** R$9,99 | **Ilimitado\*** R$18,99 |
|---|---|---|---|---|
| Workspaces Notion | 1 | 1 | 3 | 5 |
| Chunks indexados (teto) | 2.000 | 10.000 | 40.000 | 150.000 |
| `brain_search` / mês | 100 | 1.000 | 5.000 | 20.000 |
| Indexação on-demand (url/web) | ❌ | 50 pág/dia | 200 pág/dia | 500 pág/dia |
| Frescor (re-sync auto) | manual | diário | a cada 6h | a cada 1h |
| Granola + Calendar | ❌ | ✅ | ✅ | ✅ |
| Classifier + Revisitar | ❌ | ❌ | ✅ | ✅ |
| Briefing diário | ❌ | ❌ | ✅ | ✅ |

\*"Ilimitado" tem teto real (pgvector roda numa VPS só; RAM = limite físico).

### 3.1 Semântica de enforcement
- **Tetos de custo (chunks, buscas/mês, páginas on-demand/dia):** **hard-cap** — ao atingir, a operação é recusada com erro tipado e mensagem clara ("limite do plano atingido, faça upgrade"). **Aviso em 80%** (soft) exposto no portal e, opcionalmente, anexado ao resultado do `brain_search`.
- **Feature gates (Granola/Calendar, Classifier/Revisitar, Briefing, on-demand):** liga/desliga **por plano**. Conta sem a feature: a fonte/cron simplesmente não roda pra ela.
- **Janela de cota:** **mês-calendário UTC** (v1, simples). `queryUsage(accountId, metric, since)` com `since = início do mês corrente`.
- **Owner:** plano `owner` → todas as checagens retornam "ilimitado". **Comportamento do Bruno idêntico ao de hoje.**
- **Grandfathering:** contas existentes (friends) migram pra `free`. **Não apagamos dados** acima do teto: se uma conta já passou do teto de chunks, a indexação nova é bloqueada (precisa upgrade ou reduzir), mas o que já está indexado continua buscável. Migração é aditiva e não-destrutiva.

---

## 4. Arquitetura-alvo

### 4.1 Schema (migração aditiva, idempotente)
`account` ganha: `plan text NOT NULL DEFAULT 'free'`, `stripe_customer_id text`, `stripe_subscription_id text`, `plan_status text` (`active`/`past_due`/`canceled`), `current_period_end timestamptz`. Seed: `bruno` → `plan='owner'`.
Tabela nova `billing_events(stripe_event_id text PK, type text, account_id text, received_at timestamptz DEFAULT now())` pra **idempotência** do webhook.
Índice `usage_log` já serve `(account_id, metric, ts)` pra janela temporal.

### 4.2 Módulo de planos (fonte única da verdade dos limites)
`src/billing/plans.ts`: a matriz da §3 como objeto tipado (`PLANS: Record<PlanId, PlanLimits>`), `getPlanLimits(planId)`, e `isUnlimited(planId)` (owner). `src/billing/account-plan.ts`: `getAccountPlan(accountId)` (lê `account.plan`, cache curto como `account-bearer`). Plano vem **sempre do server**, nunca de input.

### 4.3 Uso + enforcement
`src/billing/usage.ts` (estende o metering): `queryUsage(accountId, metric, since)` (sum com janela), `getUsageSnapshot(accountId)` (chunks atuais via `count(brain_chunks)`, buscas no mês, on-demand no dia, % de cada teto). `assertWithinLimit(accountId, metric)` lança `QuotaExceededError(metric, limit, used)` tipado. Pontos de enforcement (do mapa, com file:line):
- **buscas/mês:** `rag/search.ts:~265` — `assertWithinLimit('search')` **antes** do embed+rerank; `recordUsage` após sucesso.
- **chunks (teto):** entrada de indexação — `rag/index-account.ts`, `brain-index-url-tool.ts`, `brain-index-web-tool.ts`, rota `/portal/reindex` — checa `count(brain_chunks WHERE account_id)` + incoming vs teto antes do trabalho; guard final defensivo em `storage.ts upsertChunks:~69-85`.
- **on-demand pág/dia:** handlers `brain_index_url`/`brain_index_web` — feature-gate (Free=❌) + contador diário vs teto.
- **workspaces:** rotas de conectar Notion (`/portal/notion/pat`, `/portal/notion/connect`, `/notion/callback`) — `count(account_workspaces) < maxWorkspaces`.
- **frescor (re-sync):** loop do indexer por conta — respeita `syncIntervalHours` do plano + último run.
- **feature gates:** indexer/classifier/revisitar/briefing checam `getAccountPlan` por conta e pulam o que o plano não inclui.

### 4.4 Stripe (hospedado, produção — C3)
- **Provisionamento de preços:** `scripts/stripe-setup-prices.ts` (one-shot, idempotente por `metadata.zinom_plan`): cria os 3 Products/Prices em BRL recorrente mensal e imprime os price IDs → `.env` (`STRIPE_PRICE_ESSENCIAL`/`_PRO`/`_ILIMITADO`). Rodado pelo Bruno (ou com ok dele, já que cria objetos reais na conta).
- **Checkout:** `POST /portal/billing/checkout {plan}` (session-required) → garante Stripe Customer (salva `stripe_customer_id`), cria Checkout Session (`mode=subscription`, price do plano, `client_reference_id=account_id`, `metadata.account_id`, success/cancel URLs do app) → retorna `{url}` → front redireciona.
- **Webhook:** `POST /webhooks/stripe` (público, **raw body**, assinatura verificada com `STRIPE_WEBHOOK_SECRET`). Eventos: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Mapeia `customer`→`account` (via `stripe_customer_id` salvo, **nunca** confia no client) e seta `account.plan`/`plan_status`/`current_period_end`/`stripe_subscription_id`. Cancel/delete → volta pra `free`. **Idempotente** via `billing_events` (PK no event id).
- **Customer Portal:** `POST /portal/billing/manage` (session-required) → cria Billing Portal Session → `{url}`. Cobre trocar cartão, mudar plano, cancelar.
- **Fonte da verdade:** estado da assinatura vive na Stripe; o DB é cache atualizado pelo webhook.

### 4.5 Funil + UI (C4/C5)
- **Cadastro:** inalterado (convite → Free).
- **App (`/app.html` + `app.js`):** card novo **"Plano & Uso"** — plano atual, medidores (chunks X/Y, buscas X/Y no mês, com cor em 80%/100%), botões de upgrade (Essencial/Pro/Ilimitado → `/portal/billing/checkout` → redirect), "Gerenciar assinatura" → `/portal/billing/manage`. Dados via `GET /portal/billing` (plano + snapshot de uso) ou estendendo `/portal/me`.
- **Admin (`/admin`):** colunas de `plan`/`plan_status`/`current_period_end`, uso-vs-limite por conta, e MRR aproximado (soma dos planos ativos).

---

## 5. Isolamento & segurança
- Plano resolvido **server-side** (`getAccountPlan` a partir de `account_id` do contexto), nunca de input/tool/arg.
- Enforcement é **aditivo** ao guard atual: não toca `buildFilterClauses` nem o par `account_id`+workspace. As checagens de cota são uma camada **por cima**.
- Webhook: assinatura Stripe verificada (raw body), idempotência por event id, mapeamento `customer`→`account` só via valor salvo no DB.
- Segredos (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs) só em `.env` da VPS. Nada hard-coded, nada commitado. Chave **live** entra só no go-live com ok do Bruno.
- Erros de cota são explícitos (tipados, mensagem PT-BR), nunca engolidos.

---

## 6. Fases de execução (TDD, teste falhando primeiro)

- **B0 — Schema + módulo de planos + uso.** Migração aditiva (`0009_billing.sql`); `plans.ts` (matriz §3); `account-plan.ts`; `usage.ts` (`queryUsage`/`getUsageSnapshot`/`assertWithinLimit`). Valida COGS real (preço atual Voyage/Anthropic) e sinaliza se algum plano ficar abaixo do custo. *Verificação:* migração idempotente; `getAccountPlan` (owner=ilimitado, default free); `queryUsage` com janela correto; suite verde.
- **B1 — Enforcement (freemium real).** Hard-caps (chunks/buscas/on-demand) + avisos 80% + feature-gates, todos plano-aware, owner ilimitado. *Verificação:* testes — conta Free acima do teto de chunks → indexação bloqueada (erro tipado); acima do teto de buscas → `brain_search` bloqueado; feature off → fonte pulada; **owner nunca bloqueado**; **testes de isolamento seguem verdes (sem regressão)**.
- **B2 — Stripe.** `stripe-setup-prices.ts`; rotas checkout/webhook/manage; sync de plano. Testes com Stripe **mockado** + eventos sintéticos assinados. *Verificação:* webhook seta plano certo por evento; assinatura inválida rejeitada; idempotência (evento repetido = no-op); checkout cria sessão com price+ref corretos; script idempotente.
- **B3 — UI app + admin.** Card "Plano & Uso" no `/app.html`, `GET /portal/billing`, colunas no `/admin`. *Verificação:* e2e (supertest/Playwright) — usuário convidado entra → vê Free + uso → upgrade → (Checkout modo teste) → webhook → `plan=essencial` → limites sobem; admin mostra plano.
- **B4 — Go-live.** Migração na VPS (backup antes), `.env` com chaves **live** + price IDs, webhook endpoint registrado na Stripe, 1 smoke test real (R$, com ok do Bruno), observabilidade de receita/uso no admin. **Só após ok explícito.**

---

## 7. Não-objetivos (agora)
LP pública / página de comparação de planos / marketing. Plano anual. Times / multi-assento por conta. Stripe Elements (form de cartão próprio). Dunning além de marcar `past_due`. Proração customizada (usa o default da Stripe). Entrada paga pública sem convite (vem com a LP).

## 8. Definição de pronto (verificável por máquina)
- Suite verde, incluindo: testes de cota (cada teto), feature-gates, idempotência do webhook, rejeição de assinatura inválida, e **testes de isolamento por `account_id` sem regressão**.
- e2e: convite → Free → upgrade (modo teste) → webhook → plano/limite novos refletidos no app e no admin.
- `doctor`/build verdes; comportamento mono-conta do Bruno idêntico (owner ilimitado).
- Go-live (B4): 1 transação real BRL bem-sucedida + plano sincronizado, com ok do Bruno.
