# 002-app-v2 — Área logada v2 (port do protótipo Claude Design)

Origem: bundle de design em `/tmp/design_pkg/zinom-ai/` (ler `project/v2/Zinom App v2.html`,
`project/v2/v2.css`, `project/v2/app.js` como referência visual/comportamental) +
documento "Revisão UX Zinom". O protótipo é a spec visual; a fiação de dados é real.

## Critério de aceite (gate de máquina)
1. `npm test` verde.
2. `npx playwright test` verde (specs e2e atualizados para a UI nova SEM enfraquecer asserções).
3. Pós-deploy: `GET /health` 200; `GET /app.html` contém `id="view-consultar"` e `v2.css`;
   `GET /v2.css` 200; endpoints novos respondem 401 sem sessão.

## Escopo

### Views (app.html — reestruturar)
Sidebar: Início · Fontes · Atividade · Consultar · Guia · ─ · Conta · Plano (link /plano.html).
Tabbar mobile: Início · Fontes · Consultar · Guia · Conta.

1. **Início** — dois estados (`data-zstate` ativado/novo, derivado de /portal/me + /portal/status + /portal/activation):
   - Ativado: hello-row + grid com cards: Saúde do cérebro (score+pendências, client-side),
     Sua semana (GET /portal/week), O que sua IA buscou (GET /portal/ai-searches),
     Próxima reunião (GET /portal/next-meeting + prompt de briefing copiável),
     Assistentes conectados (GET /portal/mcp-tokens, revogar inline).
   - Novo: onboarding 4 passos (conta ✓ → conectar fonte → indexar → plugar IA) + teasers.
2. **Fontes** — manter funcionalidade atual (Notion OAuth+PAT, Google, iCal com help, Granola,
   reindex com progresso), visual v2 (kv-rows, notices inline acionáveis).
3. **Atividade** — stat-strip + "Por fonte" (de /portal/status) + Explorador/Grafo ATUAL intacto
   (Cytoscape, mesclar/renomear, filtros) com toggle Lista/Grafo.
4. **Consultar** (ex-Chat) — rail de histórico desktop (localStorage, sem backend),
   composer atual (/portal/ask, citações, feedback, ações E3 preservadas),
   captura de URL: colar URL → POST /portal/index-web → capture-card.
5. **Guia** — Diagnóstico "Verificar agora" (client-side: /portal/me, /portal/status,
   /portal/mcp-tokens, fontes; linhas sessão/fontes/indexação/MCP/granola, animação sequencial),
   Conectar sua IA (abas Claude.ai/Claude Code/ChatGPT/Outra — mover fiação atual: connect-window
   5min com countdown, gerar token 1x, comandos copiáveis), Receitas filtráveis (8 cards do
   protótipo; card "Briefing da próxima reunião" parametrizado com /portal/next-meeting quando
   houver), Troubleshooting (5 accordions do protótipo), "Como o Zinom funciona" (pipeline).
6. **Conta** — Perfil (email, membro desde /portal/me.created_at), Sessões ativas
   (GET /portal/sessions, encerrar), Tokens MCP (lista atual + revogar + link p/ Guia),
   resumo do Plano (GET /portal/billing + link plano.html), Zona de perigo (dialog EXCLUIR atual).

### Saúde do cérebro — regras (client-side, determinístico)
Base 100. Por fonte conectada com estado `erro`: −25. Fonte com last_run > 7 dias: −20;
> 48h: −10. Nenhum token MCP jamais usado: −15. Índice vazio: score 0 ("Configure").
Faixas: ≥90 "Excelente" · ≥70 "Bom" · ≥40 "Atenção" · <40 "Crítico". Cada dedução vira
health-item acionável (warn → link Fontes/Guia); sem deduções → item ok único.

### Backend novo (aditivo; nada existente muda de contrato)
Migração `0015_app_v2.sql` (+ espelho em scripts/portal-dev-schema.sql):
- `ai_search_log (id bigserial PK, account_id text NOT NULL, query text NOT NULL,
  results int NOT NULL, client text, ts timestamptz NOT NULL DEFAULT now())`
  + índice `(account_id, ts desc)`. Query truncada a 300 chars.
- `ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS user_agent text`.

Instrumentação: em `runSearch` (src/rag/search.ts, junto ao recordUsage "search"),
best-effort `recordSearchEvent(accountId, query, hits.length, client)` — nunca quebra a busca.
`client` vem do RequestContext: novo campo opcional `tokenLabel` setado pela auth layer
(bearer de conta → label do token; oauth → "Claude.ai"; fora de request → não loga).
Buscas do /portal/ask logam com client "Consultar".

Endpoints (todos atrás de requireSession, escopo SEMPRE da sessão):
- `GET /portal/ai-searches` → `{searches:[{query, results, client, ts}]}` últimos 50 / 7 dias.
- `GET /portal/week` → `{documents, meetings, by_source:[{source_type,count}],
  recent:[{title, source_type, indexed_at}] (≤6)}` — brain_chunks/documents últimos 7 dias.
- `GET /portal/next-meeting` → `{found, title?, starts_at?, calendar?, attendees?}` — próximo
  evento futuro dos chunks source_type calendar da conta (inspecionar metadata real do
  calendar-ics-source/account-sources para o campo de data).
- `POST /portal/index-web {url}` → reusa o caminho do brain_index_web tool com accountId da
  sessão (mesma validação de URL + quota index_pages). Resposta `{ok, title?}`.
- `GET /portal/sessions` → `{sessions:[{id, current, created_at, last_seen_at, user_agent}]}`.
- `POST /portal/sessions/revoke {id}` → 204 (404 se de outra conta; não pode revogar a atual? pode —
  se revogar a atual, frontend redireciona ao login).
- `GET /portal/me` passa a incluir `created_at`.

### CSS
Novo `portal/v2.css` (copiar/adaptar o v2.css do bundle; mesmos tokens do styles.css),
linkado após styles.css em app.html. styles.css só recebe ajustes mínimos se necessário.

### Fora de escopo
Admin, histórico de conversas persistente em banco, digest por e-mail, grafo novo,
login/landing/plano.html (inalterados), geolocalização de sessão.

## Segurança
- Todo endpoint novo: account_id exclusivamente da sessão; nunca de input.
- index-web: validar http(s), aplicar quota existente; não logar a URL além do ai_search_log? —
  index-web NÃO entra no ai_search_log (não é busca).
- Nada de segredo em log; query do usuário só na tabela da própria conta (feature de transparência).

## Deploy (após merge em main)
ssh zinom-vps → git pull → npm ci → npm run migrate (0015) → npm run build →
pm2 restart notion-mcp → pm2 logs limpo → smoke (critério acima, via https://zinom.ai).
