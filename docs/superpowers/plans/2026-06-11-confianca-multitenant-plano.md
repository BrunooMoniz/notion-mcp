# Plano de execução: confiança multi-tenant (2026-06-11)

Spec: `docs/superpowers/specs/2026-06-11-confianca-multitenant-design.md`.
Execução em 4 frentes paralelas (worktrees/branches separados), merge
sequencial com rebase (C → D → E tocam portal/app.js), CI verde obrigatório,
deploy único ao final.

## Frente A — `fix/indexacao-multiconta` (F2)
Arquivos: src/portal/activity-status.ts, src/account-tokens.ts,
src/clients.ts (resolveAccountClient), src/rag/index-account.ts,
src/rag/notion-source.ts (agregação de skips), src/portal/routes.ts (status),
portal/app.js (chip plan_limit), testes em src/portal/__tests__ e
src/rag/__tests__.
1. TDD: teste de buildActivitySources filtrando workspace sem credencial.
2. TDD: resolveAccountClient cache-miss → fallback vault; invalidação ao
   conectar/desconectar (notion-oauth/portal sources chamam invalidate).
3. TDD: indexAccount com QuotaExceededError de chunks → status_run
   `error:"plan_limit"`, run parcial ok=false não derruba outras fontes.
4. Portal: estado "limite do plano" na fonte + banner; logs agregados.

## Frente B — `fix/mcp-multitenant` (F3 + brain_status identidade)
Arquivos: src/rag/brain-index-url-tool.ts, src/index.ts (registro por sessão),
src/account-bearer.ts (accountWorkspaces), src/rag/brain-status-tool.ts.
1. TDD: schema do brain_index_url para conta friend lista workspaces da conta
   (ids + nomes), nunca os do operador; operador mantém os 3.
2. TDD: brain_status inclui `account {email, plan}`.

## Frente C — `fix/ask-resiliente` (F1)
Arquivos: src/portal/ask.ts, src/portal/routes.ts (catch global do ask),
src/alerts.ts (ou módulo ntfy existente), scripts/doctor (check Anthropic),
portal/app.js (degraded + mensagens + barra de feedback), testes ask.
1. TDD: LLM falha + hits>0 → 200 degraded com sources; LLM falha + 0 hits →
   500 {error:"llm"}; erro imprevisto → 500 {error:"unexpected"} + log.
2. ntfy throttled em falha de LLM; doctor check.
3. Front: render degraded, mensagens específicas, barra "Foi útil? 👍👎"
   (POST /portal/feedback nos chunks citados, 1 voto por resposta).

## Frente D — `fix/entidades-multiconta` (F4)
Arquivos: src/classifier/* (loop de contas), src/rag/entity-extractor.ts,
src/portal/routes.ts (graph default/empty state já ok no back),
portal/app.js (empty state do grafo), testes classifier.
1. TDD: extração itera contas com chunks (mock de pool), orçamento por conta,
   inclui friend; idempotente.
2. Front: grafo default overview + empty state explicativo quando 0 entidades.

## Frente E — `feat/guia-paginado` (F5)
Arquivos: portal/app.html, portal/app.js, portal (css se houver), Playwright
spec do portal.
1. Hub com cards (título+subtítulo) por seção; subpáginas `#guia/<slug>`;
   redirect dos deep-links antigos; navegação voltar.
2. Playwright: hub → subpágina → voltar; deep-link antigo redireciona.

## Sequência de merge e deploy
1. PRs A e B (backend puro) → CI → merge.
2. PR C → rebase em main → CI → merge.
3. PR D → rebase (app.js) → CI → merge.
4. PR E → rebase (app.html/js) → CI → merge.
5. Deploy VPS: git pull --ff-only && npm ci && npm run build && npm run
   migrate && pm2 restart notion-mcp brain-indexer brain-classifier
   --update-env; verificação: /health 200, zinom.ai/mcp 401, npm run doctor.
6. Pós-créditos (Bruno): reindex/extração backfill da conta gmail; smoke do
   /portal/ask e do grafo.

## Pendência operacional (Bruno)
- Recarregar créditos da Anthropic API (console.anthropic.com → Plans &
  Billing). Sem isso o chat responde em modo degradado e entidades não são
  extraídas.
