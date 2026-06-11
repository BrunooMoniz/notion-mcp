# Zinom — Gap analysis dos 6 objetivos + roadmap de execução

## Atualização 2026-06-09 — estado real dos branches

**Auditoria feita em:** 2026-06-09
**Método:** `git fetch --all --prune` + análise de commits-ahead, diff-stat e grep de conteudo em `origin/main` para cada branch local e remoto.

### PRs mergeados em main apos 2026-06-07 (baseline `5467c68`)

| PR | Branch | Conteudo |
|----|--------|---------|
| #44 | `feat/google-calendar-multi-account` | Google Calendar multi-conta: 5 tools MCP (list/create/update/delete), vault `google_oauth`, portal connect/disconnect, isolamento por tenant. Remote branch deletado apos merge (confirmado pelo prune). |
| #45 | `feat/zinom-remediation` | Time-blocking + onboarding dup-safe de eventos via Notion + citacao de fontes em respostas (`brain-format.ts`). |
| #46 | `feat/portal-brain-insights` | Portal WS3: card de status do brain + navegador de documentos (account-scoped). |
| #47 | `feat/notion-multiaccount-ui` | UI do portal para gerenciar multiplas conexoes Notion (listar/nomear/remover). |
| #48 | `feat/admin-block-insights` | Admin: enforce de suspensao no path `/mcp` (auth guard), block/unblock de conta, insights mais ricos. |
| #49 | `feat/conversation-memory-citation` | Memoria de conversas: tools `remember`/`recall` + contrato de citacao de fontes (title + source_url). |

### Estado real de todos os branches (em 2026-06-09)

| Branch | Escopo | Commits a frente de `origin/main` | Conteudo ja em main? | Recomendacao | Justificativa |
|--------|--------|:---------------------------------:|----------------------|--------------|---------------|
| `origin/feat/001-account-portal` | Portal de convites e onboarding | 0 | Sim (totalmente) | DELETAR remoto | Conteudo incorporado; PR #36/#37 mergeados ha muito. |
| `origin/feat/admin-block-insights` | Admin block/insights | 0 | Sim (PR #48) | DELETAR remoto | Mergeado via PR #48. |
| `origin/feat/billing-freemium` | Billing Stripe + planos | 0 | Sim (PR #40) | DELETAR remoto | Mergeado via PR #40; local identico ao remoto. |
| `origin/feat/billing-lp-usage-screen` | LP de planos + tela de consumo | 0 | Sim (PR #42) | DELETAR remoto | Mergeado via PR #42. |
| `origin/feat/conversation-memory-citation` | Memoria de conversas + citacao | 0 | Sim (PR #49) | DELETAR remoto | Mergeado via PR #49. |
| `origin/feat/notion-multiaccount-ui` | UI multi-conta Notion | 0 | Sim (PR #47) | DELETAR remoto | Mergeado via PR #47. |
| `origin/dev` | Historico antigo (ate PR #26) | 0 | Sim (totalmente) | DELETAR remoto | Todos os commits ja estao em main; branch parou em PR #26. |
| `feat/admin-block-insights` (local) | Igual ao remoto acima | 0 | Sim (PR #48) | DELETAR local | Espelho local do remote ja mergeado. |
| `feat/billing-freemium` (local) | Igual ao remoto acima | 0 | Sim (PR #40) | DELETAR local | Identico ao origin/feat/billing-freemium. |
| `feat/billing-lp-usage-screen` (local) | Igual ao remoto acima | 0 | Sim (PR #42) | DELETAR local | Espelho local do remote ja mergeado. |
| `feat/conversation-memory-citation` (local) | Igual ao remoto acima | 0 | Sim (PR #49) | DELETAR local | Espelho local do remote ja mergeado. |
| `feat/notion-multiaccount-ui` (local) | Igual ao remoto acima | 0 | Sim (PR #47) | DELETAR local | Espelho local do remote ja mergeado. |
| `feat/cerebro-provisioner` (local) | Aponta para tip de main | 0 | N/A (e main) | DELETAR local | Aponta para o mesmo commit de `origin/main` (`490cff8`); placeholder vazio. |
| `feat/google-index-blocktime` (local) | Aponta para tip de main | 0 | N/A (e main) | MANTER WIP | Aponta para `origin/main` (`490cff8`); nome sugere trabalho futuro planejado (indexar contas Google + block-time), mas nao tem commits proprios ainda. |
| `feat/substrate-hardening` (local) | Aponta para tip de main | 0 | N/A (e main) | MANTER WIP | Aponta para `origin/main`; nome sugere WIP planejado (obj. 7), sem commits proprios. |
| `feat/landing-redesign` (local) | LP redesign | 0 | Sim (PR #37) | DELETAR local | Tip (`5602fc1`) ja esta em main via PR #37. |
| `feat/f3-billing-freemium` (local) | Billing Stripe (versao antiga) | 19 | Parcial/OBSOLETO | OBSOLETO | Divergiu do baseline em PR #38; billing entrou em main via PR #40 com commits diferentes. O branch nao tem Google Calendar, admin-block, memoria nem citacao (PRs #44-#49). Nenhum arquivo unico; tem 62 arquivos com diff negativo (main tem mais codigo). |
| `feat/reliable-account-indexing` (local) | Identico a `feat/f3-billing-freemium` | 19 | Parcial/OBSOLETO | OBSOLETO | SHA-por-SHA identico a `feat/f3-billing-freemium`. Mesmo diagnostico: billing ja em main, o restante esta desatualizado. |

### Proximos merges recomendados (ordem de valor x risco)

Todos os branches existentes estao incorporados ou sao obsoletos. **Nao ha merge pendente de branch existente.** O proximo trabalho e greenfield:

1. **`feat/google-index-blocktime`** (novo trabalho): indexar contas Google OAuth por conta na memoria (indexer) + ligar task->evento (block-time). E o gap remanescente do obj. 3 documentado no roadmap T2.2. Ja existe o local placeholder com o nome correto.
2. **`feat/cerebro-provisioner`** (novo trabalho): scaffolding do Cerebro por usuario (classifier/cron por conta, Granola->Reuniao, historico semanal). Maior build do produto (obj. 2, tier 3). Local placeholder existe.
3. **`feat/substrate-hardening`** (novo trabalho): `brain_facts` com account_id scope, cascade/purge de conta, SECRETS_KEY por tenant. Endurece multi-tenancy (obj. 7, T2.3). Local placeholder existe.

---


**Data:** 2026-06-07
**Método:** workflow de 7 agentes leitores em paralelo contra `origin/main` (baseline limpo `5467c68`, worktree `.context/nmcp-main`) + leitura dos 3 branches não-mergeados.
**Repo de código:** `BrunooMoniz/notion-mcp` (deploy PM2 na VPS). **Repo de planejamento:** este (`mcp-notion`).

## TL;DR

O produto **já é maduro e multi-tenant**. A maior parte do substrato dos 6 objetivos existe em `main`: vault cifrado por conta (kinds `notion_pat`/`granola`/`ical`), indexação isolada por conta, bearer MCP por conta, portal, billing Stripe, admin. Os objetivos são, em grande parte, **completar e estender**, não construir do zero. As exceções (greenfield real) são: **Cérebro estruturado por usuário** (obj. 2, XL) e **memória de conversas** (obj. 4, L).

Há 3 branches com trabalho pronto não-mergeado: `feat/google-calendar-multi-account` (13), `feat/zinom-friend-complete` (2), `feat/zinom-remediation` (3).

## Estado por objetivo

| # | Objetivo | Estado hoje (`main`) | Gap principal | Esforço restante |
|---|---|---|---|---|
| 1 | Notion próprio / PAT / N contas | Backend pronto: PAT+OAuth, multi-workspace por conta, indexação isolada, cap por plano | UI mostra Notion como conexão única (sem lista, sem "adicionar outro", sem desconectar); cap de plano conflita com "quantas quiser" | **M** (UI + ciclo de vida) |
| 2 | Cérebro organizado no Notion do usuário (conhecimento/insights/histórico semanal/Granola→Reunião/kanban) | Operador (Bruno) tem Cérebro completo via classifier cron hardcoded nos UUIDs dele. Amigo só tem: RAG search + kanban "Tarefas" | Nenhum classifier/scaffolding por conta; Granola do amigo é só buscável, não vira página; sem histórico semanal por usuário; skills hardcoded | **XL** (maior build) |
| 3 | Google Calendar multi-conta (ler/indexar/criar/editar/excluir, block-time) | `main` é read-only (iCal + 1 OAuth global). Branch `feat/google-calendar-multi-account` entrega read+write multi-conta para dono+amigos (testado) | Após merge: indexar contas OAuth novas na memória; ligar task→evento (block-time); free/busy; gate de billing; verificação Google | **L** (merge é M) |
| 4 | Q&A com fontes citadas + memória de conversas | `brain_search` retorna source_type/url/metadata por hit; dados de proveniência existem | Sem memória de conversas (greenfield); sem contrato de citação nas instruções; facts write-only/OFF; sem tool de "resposta sintetizada" | **L** (memória é o grosso) |
| 5 | Área logada: mais insight do próprio cérebro | Portal é gestão de fontes + billing | Sem visão do que há no cérebro (contagem por fonte), sem feed de itens recentes, saúde por fonte escondida (só /status do operador) | **M** (endpoints read + UI) |
| 6 | Admin: bloquear usuário + insights | Admin read-only + ações de convite. `account.status` existe mas não é aplicado no auth | Sem ação de block (blocker); status não barra no auth (blocker); sem insight de erros; uso raso; MRR cru; saúde por fonte siloed | **M** |
| 7 | Substrato multi-tenant (sob tudo) | Isolamento de dados é production-grade (account_id forçado em chunks/search/secrets, sessão ligada à conta) | `brain_facts` sem account scope (leak latente, FACTS off); sem FK/cascade nem rotina de deleção (LGPD); SECRETS_KEY único global; sem store de memória; caches em memória travam scale-out | **L** |

## Branches não-mergeados (trabalho pronto)

> [OBSOLETO em 2026-06-09: ver atualização no topo] Esta seção refletia o estado em 2026-06-07. Todos os branches listados abaixo foram mergeados (PRs #44 e #45) e os remotes deletados.

- **`feat/google-calendar-multi-account`** (13 commits): multi-conta Google ler/criar/editar/excluir, vault `google_oauth` por tenant, portal connect/disconnect, exposto a dono+amigos, suíte de testes. **Não indexa** as contas novas na memória (indexer intocado). → PR + merge + deploy + passo no Google Cloud (escopos + "Em produção").
- **`feat/zinom-friend-complete`** (2): janela OAuth self-service + storage.ts + UI connect-window. Verificar sobreposição com #43 já mergeado.
- **`feat/zinom-remediation`** (3): time-blocking + onboarding de evento dup-safe via Notion + `brain-format.ts` (formatação de saída). Fatia do obj. 2/4.

## Roadmap proposto (sequência por valor × risco)

**Tier 0 — Shippar o pronto (ROI alto, risco baixo):**

> [OBSOLETO em 2026-06-09: ver atualização no topo] T0.1 e T0.2 foram concluídos — PRs #44 e #45 mergeados. Tier 0 encerrado.

- T0.1 PR + merge `feat/google-calendar-multi-account` (obj. 3 núcleo).
- T0.2 Avaliar/mergear `feat/zinom-remediation` e `feat/zinom-friend-complete`.

**Tier 1 — Completar (M, aditivo, alto valor visível):**

> [OBSOLETO em 2026-06-09: ver atualização no topo] T1.1, T1.2 e T1.3 foram todos entregues: T1.1 via PR #47, T1.2 via PR #46, T1.3 via PR #48. Tier 1 encerrado.

- T1.1 Notion multi-conta: UI lista + "adicionar outro" + desconectar (obj. 1).
- T1.2 Área logada: `/portal/insights` + `/portal/recent` + seção no app (obj. 5).
- T1.3 Admin: ação block + guard `account.status` no auth + revoke + audit + insights (obj. 6).

**Tier 2 — Builds maiores (L):**

> [OBSOLETO em 2026-06-09: ver atualização no topo] T2.1 foi entregue via PR #49 (remember/recall + citacao de fontes). T2.2 e T2.3 permanecem como proximo trabalho greenfield — ver recomendacoes no topo.

- T2.1 Contrato de citação + tool de resposta + memória de conversas (obj. 4).
- T2.2 Indexação Google por conta + ligação task→evento block-time (obj. 3 resto).
- T2.3 Endurecer substrato: facts account-scope, deleção/purge de conta + FKs (obj. 7).

**Tier 3 — XL:**
- T3.1 Cérebro estruturado por usuário (Granola→Reunião + Insights + histórico semanal no Notion do usuário) (obj. 2).

## Forks de produto (decisões que mudam o escopo — não inventar)

1. **Escopo do Cérebro por usuário (obj. 2, XL):** Cérebro completo por usuário, ou versão mais leve (Granola→Reunião + insights + histórico semanal, reusando estrutura existente), ou manter search+kanban?
2. **Arquitetura da memória de conversas (obj. 4):** tools `remember`/`recall` gravando como 5º source_type em `brain_chunks` (ganha retrieval+citação de graça), store separado, ou adiar?
3. **"Quantas quiser" vs cap por plano (obj. 1):** manter cap como alavanca de billing, afrouxar, ou Notion ilimitado em todo plano pago?
4. **Autoridade de merge/deploy neste run:** PRs + você dá o "go" por lote, ou autonomia total (merge+deploy ao passar testes+security)?

## Invariantes de segurança (não regredir)

- `account_id` sempre de `getAccountId()`, nunca do input da tool.
- Todo secret cifrado AES-256-GCM no vault; nunca em log nem retornado por tool/rota.
- Operação destrutiva exige `confirm: true` + `auditWrite`.
- Gate de escopo por workspace nas brain tools.
- `npm test` + `tsc` verdes antes de qualquer merge; nenhum teste enfraquecido.
