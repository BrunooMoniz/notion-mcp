# Confiança multi-tenant: diagnóstico e design (2026-06-11)

Contexto: primeiros usuários reais em onboarding. Bruno onboardou a conta
`brunoomoniz@gmail.com` (`friend:0fde0b29...`, plano ilimitado comp, 8.6k chunks)
e encontrou: chat Consultar com "Erro inesperado" em toda consulta, Grafo do
Explorador vazio, fonte "personal" presa em "aguardando", confusão entre contas
no MCP, e Guia longo demais. Sessão autônoma: decisões de produto tomadas de
forma conservadora e registradas aqui.

## Diagnóstico (evidências verificadas em produção)

1. **Anthropic API sem créditos** (causa raiz dominante, operacional).
   `POST /v1/messages` responde 400 "credit balance is too low" para a chave de
   produção. Consequências em cascata:
   - `/portal/ask`: a busca funciona (ai_search_log registra 8 resultados por
     consulta), mas a geração falha no catch silencioso de `ask.ts` → 502
     `{error:"llm"}`. O Cloudflare substitui corpos 502/504 da origem pela
     página de erro HTML dele → o front não consegue ler o JSON → cai no
     fallback "Erro inesperado. Tente de novo." (mensagem errada e sem pista).
   - Classificador de intenção (`classifyIntent`) falha silencioso → tudo roteia
     para search (até "Está funcionando?", que é meta).
   - `brain-classifier` ([entities]) falha em TODOS os chunks há dias → contas
     novas têm 0 entidades → Grafo vazio.
   - Nenhum alerta: catches silenciosos, sem ntfy, sem check no doctor.
2. **Fonte fantasma "personal"**: `FRIEND_WORKSPACE="personal"` é registrado em
   `account_workspaces` pelo pass de Granola/iCal (`ensureAccountWorkspace`).
   O `/portal/status` (buildActivitySources) lista esse workspace sintético como
   se fosse um Notion aguardando primeira indexação (0 docs, "aguardando").
3. **Indexer multi-conta pula bases**: conta `friend:eacfd9f8` tem centenas de
   skips `no pat token ... (warmAccount first)` para workspace `1a6adef7` que
   não está mais em `account_workspaces` (PAT ausente do vault). O descobridor
   de bases conhece o workspace (via sync_state/discovery antiga) mas o cache de
   tokens não tem entrada → skip permanente e silencioso.
4. **Teto de chunks do plano invisível**: `friend:eacfd9f8` (free) atingiu
   1999/2000 chunks e o run inteiro falha com `[index-account] FAILED: Limite do
   plano atingido`. O usuário não vê nada no portal além de fontes "ok".
5. **Duas contas do mesmo humano**: o MCP do Claude.ai do Bruno autentica a
   conta `friend:eacfd9f8` (outro email), enquanto o portal usa a conta gmail.
   `brain_status` não diz qual conta/email está respondendo → confusão "cadê a
   Nora?" (a conta do MCP nunca teve o Notion da Nora).
6. **Enum de workspaces vaza config do operador**: `brain_index_url` expõe
   `enum ["personal","globalcripto","nora"]` (clients.ts ALL_WORKSPACES) para
   QUALQUER conta, revelando os workspaces privados do operador e impedindo o
   friend de indexar nos workspaces dele.
7. **Grafo sem default útil e sem estado vazio explicativo**; lista já ordena
   por recência (ok).
8. **Guia**: página única de ~420 linhas de HTML (app.html 552-969), experiência
   ruim.

## Decisões de design

### F1. Resiliência do /portal/ask (mais importante para o usuário)
- **Modo degradado**: se a chamada LLM falhar mas a busca tiver resultados,
  responder HTTP 200 com `{degraded:true, reason:"llm_unavailable", answer:null,
  sources:[...]}`. O front renderiza as fontes com aviso "A IA está
  temporariamente indisponível; aqui está o que encontrei no seu cérebro".
- **Nunca responder 502/504** (Cloudflare troca o corpo): erros de LLM sem
  resultados viram **500** com JSON `{error:"llm"}` (CF preserva 500) e os erros
  imprevistos ganham catch global no router: log com stack + `500
  {error:"unexpected"}`.
- **Logar e alertar**: todo erro de LLM loga `[portal/ask] llm error:` com o
  erro real; alerta ntfy (tópico existente) com throttle (1 a cada 10 min).
- **Doctor**: novo check de Anthropic (chamada mínima) reportando
  auth/credit/conn.
- **Feedback de consulta**: manter consultas FORA do cérebro (já são só
  localStorage). Adicionar barra "Essa resposta foi útil? 👍 👎" por resposta,
  aplicando o delta nos chunks citados via POST /portal/feedback (já existe);
  pontua a memória (utility score) sem persistir a consulta.

### F2. Indexação multi-conta confiável
- **Workspace sintético não é fonte**: buildActivitySources só lista como fonte
  Notion workspaces com credencial (`notion_pat:*`/`notion_access:*`). O
  registro `personal` (Granola/iCal) não aparece como Notion "aguardando".
- **Cache de PAT com fallback**: `resolveAccountClient` em cache-miss tenta o
  vault diretamente (lazy) antes de pular; conectar/desconectar workspace
  invalida o cache do account. Skips por token ausente são agregados (1 log por
  workspace por run, não 1 por base).
- **Teto de plano visível e não-fatal**: ao estourar `maxChunks` durante o run,
  registrar status_run com `error:"plan_limit"` e contadores parciais; o portal
  mostra chip "Limite do plano atingido — faça upgrade" na fonte e no topo; o
  restante das fontes continua.
- **brain_status com identidade**: payload passa a incluir `account
  {email, plan}` para o usuário saber qual conta o token MCP atende.

### F3. MCP multi-tenant correto
- `brain_index_url`: enum de workspace dinâmico por conta (nomes de
  `account_workspaces` + name amigável); operador mantém os 3 atuais. Nenhum
  nome de workspace do operador aparece para contas friend.

### F4. Entidades e Grafo por conta
- `brain-classifier` extrai entidades para TODAS as contas com chunks (não só
  operador): loop por conta com orçamento por run (ex.: 200 chunks/conta/run),
  contas friend incluídas; ENTITIES_ENABLED continua o gate global.
- Grafo: default = overview (top entidades por menções) já existente; estado
  vazio explicativo ("entidades em extração — volte em instantes") quando a
  conta tem chunks mas 0 entidades; backfill da conta gmail após créditos.
- Lista do Explorador: mantém ordenação por recência (doc_date DESC) como
  default "mais relevante primeiro" (reuniões, páginas, eventos recentes).

### F5. Guia paginado
- Página hub com cards (título + subtítulo, 1 clique) e subpáginas por seção via
  hash routing `#guia/<slug>` reutilizando o padrão `go()`/views existente:
  verificar, conectar (tabs), tarefas, receitas, problemas, como-funciona.
- Deep-links antigos (`#guia-conectar` etc.) redirecionam para as novas rotas.

## Fora de escopo (registrado, não fazer agora)
- Recarga de créditos Anthropic (ação do Bruno no console — bloqueia o fim a fim
  do chat/entidades em produção).
- Unificação das duas contas friend do Bruno; rotação de segredos pendentes.
- Reranking/score no Explorador (lista por recência atende o pedido).

## Critérios de aceite (verificáveis por máquina)
1. `npm test` verde com novos testes: ask degradado (LLM falha + hits → 200
   degraded), ask 500 nunca 502, fonte sintética filtrada, fallback de vault no
   cache-miss, plan_limit não-fatal com status_run, enum dinâmico por conta,
   extração de entidades multi-conta (unit com deps injetadas).
2. Playwright: Guia hub renderiza cards e navega para subpáginas; Consultar
   renderiza modo degradado com fontes.
3. Pós-deploy (com créditos): `POST /portal/ask` da conta gmail responde 200 com
   answer ou degraded; `GET /portal/brain/graph` retorna nós > 0 para a conta
   gmail após backfill; `https://zinom.ai/mcp` responde 401.
