# T3.1 — Cérebro completo por usuário + classifier por conta (obj. 2, XL) — Design

**Data:** 2026-06-07. **Decisão travada:** Cérebro COMPLETO por conta (resposta do Bruno).

## Objetivo
Cada usuário (amigo) passa a ter, no SEU Notion, a estrutura Cérebro completa — **Reuniões, Insights, Diário Semanal, Pessoas, Organizações, Revisitar** — alimentada automaticamente por classifier + Granola→Reunião + Revisitar **por conta**, em cadência. O caminho do operador (Bruno) fica **idêntico** (zero regressão na Cérebro viva dele).

## Estado atual (a generalizar)
As 3 pipelines são single-tenant, hardcoded em `src/classifier/*`:
- `notion-classifier.ts`: `NOTION_PERSONAL_TOKEN` + `notionFetch("personal", …)` + UUIDs das DBs do Bruno (Reunioes/Insights/Pessoas/Organizacoes).
- `granola-to-reuniao.ts`: FEEDS `GRANOLA_*_TOKEN` + `REUNIOES_DS/DB` hardcoded.
- `revisitar.ts`: `PARENT_PAGE_ID` (Cérebro) + Insights/Revisitar DS/DB hardcoded.
- `index-classifier.ts`: cron único roda tudo 1× (pro Bruno).

## Padrões a espelhar (já provados no repo)
- **Provisioner**: `src/portal/task-tracker.ts` — clients-free, `fetch` cru com token do vault (`resolveAccountNotion` = warmAccount + getAccountToken), detect via `/v1/search`+GET schema, create page+DB, grava data_source id no vault (kind), `fetchImpl` injetável p/ teste; schemas em `task-tracker-schema.ts`.
- **Fan-out por conta**: `src/billing/resync-cron.ts` — itera `account WHERE status='active' AND kind='friend'`, roda sequencial, `indexFn` injetável.

## Decomposição (slices shippáveis)
- **T3.1a Provisioner** `src/portal/cerebro-provisioner.ts` (+ `cerebro-schema.ts`): cria/detecta "🧠 Cérebro" + as 6 DBs com os schemas espelhando os do Bruno; grava os data_source ids no vault sob **um** kind JSON `cerebro_dbs` = `{parent_page_id, reunioes_ds, insights_ds, pessoas_ds, organizacoes_ds, diario_ds, revisitar_ds}`. Idempotente (detecta existente). **Sem migração** (vault é free-kind). Rota `POST /portal/cerebro/provision` + botão no portal; helper `getCerebroDbs(accountId)`.
- **T3.1b Classifier por conta**: extrair `runClassifierForAccount(accountId, {fetchBound, dbs})` de `runClassifier()`. A camada de rede passa a usar `fetch` com o **token do vault** da conta (como task-tracker.ts), não `notionFetch("personal")`. `runClassifier()` vira o wrapper do operador (token env + UUIDs do Bruno) → **backward compat**.
- **T3.1c Granola→Reunião por conta**: `syncGranolasForAccount(accountId, {granolaKey, reunioesDs})` usando a chave Granola do vault (kind `granola`) + Reuniões provisionada. Wrapper do operador mantém os FEEDS env.
- **T3.1d Revisitar por conta**: `runRevisitarForAccount(accountId, {dbs})` com Insights/Revisitar provisionadas.
- **T3.1e Scheduling**: em `index-classifier.ts`, após o tick do operador, fan-out (espelha resync-cron) sobre contas friend ativas **com Cérebro provisionado**, rodando b/c/d por conta. Gate: ter `cerebro_dbs` no vault (e, se quiser monetizar, um feature flag de plano — decidir). Custo LLM (Haiku) por conta: registrar em usage/metering.
- **T3.1f skills** (meu-dia/follow-up/…): generalizar p/ schema-discovering — **follow-up**, fora deste slice.

## Invariantes
- Token/identidade da conta sempre do vault/contexto, nunca do input.
- Operador inalterado (wrappers preservam env+UUIDs); per-account é puramente aditivo.
- TDD: builders puros + fetch/pool injetáveis (casos com DB/LLM self-skip sem creds), como o resto do repo. `tsc` + `npm test` verdes; sem enfraquecer teste.

## Ordem de execução
T3.1a (provisioner, fundação + valor isolado) → T3.1b → T3.1c → T3.1d → T3.1e. Cada slice: branch próprio, PR, CI, merge, deploy.
