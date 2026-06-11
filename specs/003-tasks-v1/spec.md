# 003-tasks-v1 — Ciclo de tarefas e planejamento (Kanban padrão + adapter + plan context)

O maior valor diário do Zinom: todas as tarefas do usuário vivem numa base Notion
que o Zinom conhece profundamente; reuniões do Granola viram tarefas (fazer ou
cobrar); a IA planeja dia/semana/mês cruzando agenda real + board, aloca blocktime
e mantém o board atualizado. Onboarding e Guia ensinam o fluxo linearmente.

## Critério de aceite (gate de máquina)
1. `npm test` e `npm run build` verdes; `npx playwright test` verde.
2. Pós-deploy, via conexão MCP real (conta-bearer): `zinom_list_tasks` lista o board;
   `zinom_create_task` cria com prioridade/tipo/origem; `zinom_update_task` muda status
   (done seta data de conclusão quando o campo existe); `zinom_plan_context` retorna
   eventos + slots livres + board agrupado para uma semana.
3. App.html serve a nova seção do Guia (marcador `id="guia-tarefas"`) e o painel
   Claude Code reescrito (`claude mcp add` com `-s user`).

## Arquitetura central: modelo canônico + adapter de schema (`src/tasks/`)

O Zinom precisa usar QUALQUER base de tarefas com excelência: a padrão (pt-BR,
select) e a que o usuário já tem (ex.: a do owner é em inglês com Status tipo
`status`: Backlog/To-do/Blocked/In progress/Canceled/Done, Priority
Ultra/High/Medium/Low, Due date, Tempo estimado em minutos, Projeto multi_select).
A solução é um modelo canônico + adapter que mapeia para o schema real.

### Modelo canônico (`src/tasks/model.ts`)
- status: `backlog | todo | in_progress | blocked | done | canceled`
- prioridade: `urgente | alta | media | baixa`
- Task: { id, url, title, status, prioridade?, prazo? (ISO), prazo_fim?,
  tempo_estimado_min?, tipo?: 'fazer'|'cobrar', quem?, origem_url?, projeto?,
  criada_em?, concluida_em? }
- Tabelas de sinônimos (case/accent-insensitive, reuse normalize() existente):
  - status: backlog→[backlog]; todo→[a fazer, to-do, todo, fazer, not started, para fazer];
    in_progress→[fazendo, em andamento, in progress, doing, em progresso];
    blocked→[bloqueada, bloqueado, blocked, travada]; done→[feito, feita, concluída,
    concluído, done, complete, completed]; canceled→[cancelada, cancelado, canceled, cancelled]
  - prioridade: urgente→[urgente, ultra, urgent, p0, crítica]; alta→[alta, high, p1];
    media→[média, media, medium, p2, normal]; baixa→[baixa, low, p3]
  - nomes de propriedade: prazo→[prazo, due, due date, data limite, deadline, entrega,
    vencimento, data]; tempo→[tempo estimado, estimate, estimativa, esforço, effort,
    duração, min]; tipo→[tipo, type]; quem→[quem, responsável, owner, cobrar de];
    origem→[origem, fonte, source, link]; projeto→[projeto, frente, área, area, project];
    concluída_em→[concluída em, concluido em, completed, done at, finalizada em];
    prioridade→[prioridade, priority, prio]

### Adapter (`src/tasks/adapter.ts`)
`loadTrackerProfile(accountId)`:
1. Resolve o data_source id: vault `tasks_db` (getTasksDbId). Para o OWNER
   (DEFAULT_ACCOUNT_ID) sem vault: fallback para `OWNER_TASKS_DS_FALLBACK` =
   "30d07ba5-bee8-8040-841b-000b5d0b5d84" (o id hoje hardcoded em
   daily-briefing.ts:31 — mover para constante exportada; o deploy configura o
   vault e o fallback vira rede de segurança do cron de briefing).
2. Resolve tokens: novo helper `resolveNotionTokens(accountId)` → lista
   {workspace, token}: friend = vault (padrão de task-write.ts
   resolveTokenForDataSource); owner = tokens do .env (clients.ts) na ordem
   personal, globalcripto, nora. Reusar/refatorar resolveTokenForDataSource para
   cobrir o owner — task-write passa a usar o mesmo helper.
3. GET /v1/data_sources/{id} → constrói TrackerProfile:
   { dataSourceId, url, title, props: { title, status?: {name, kind:'status'|'select',
   map: canonical→option real, reverse}, prioridade?, prazo?, tempo?, tipo?, quem?
   (APENAS rich_text — people fica de fora), origem? (url|rich_text), projeto?
   (select|multi_select), concluida_em?, criada_em? }, missing: [campos canônicos
   sem propriedade] }
   - status prop: primeira do tipo `status`; senão select status-like (reusar
     hasStatusLike). Mapear opções reais→canônico por sinônimo; opção real sem
     sinônimo fica acessível por nome literal (passthrough).
   - Cache em memória TTL 5 min por accountId; `invalidateTrackerProfile(accountId)`
     chamado quando um write falha com 400 de propriedade → recarrega e tenta 1x.
4. Escrita de status canônico sem opção correspondente: select → escreve o nome
   pt padrão (Notion cria a opção); status-type → erro claro listando as opções
   disponíveis (a IA escolhe pelo passthrough). done com prop concluida_em → seta hoje.
5. tipo='cobrar' sem prop tipo → prefixo "Cobrar: " no título (apenas no create).

### Leitura (`src/tasks/read.ts`)
`listTasks(accountId, {status?: canonical[], incluir_concluidas?, prazo_ate?,
prazo_de?, q?, limit? (default 25, max 100)})` → query do data source com filtros
construídos pelo profile (status/select equals; date on_or_before/after; title
contains para q), sort prazo asc (sem prazo no fim), tie-break prioridade
(urgente>alta>media>baixa). Retorna Task[] canônicas + `board`: contagem por
status + soma tempo_estimado_min dos abertos + overdue_count.

### Escrita (`src/tasks/write.ts`)
- `createTask(accountId, input canônico)` — generaliza buildTaskPagePayload via
  profile; origem_url no prop origem (ou primeira linha da nota se ausente);
  mantém corpo/nota como hoje.
- `updateTask(accountId, pageId, patch)` — ANTES de escrever: GET da página e
  verificação de que `parent.data_source_id === profile.dataSourceId` (isolamento;
  404 caso contrário). patch: status, prioridade, prazo, prazo_fim,
  tempo_estimado_min, titulo, tipo, quem, projeto, nota_append (appenda paragraph).
- task-write.ts atual passa a delegar para cá (compat: createTaskPage mantém
  assinatura, vira wrapper).

### Template padrão novo (task-tracker-schema.ts TARGET_PROPERTIES)
Nome(title) · Status(select: Backlog, A fazer, Em andamento, Bloqueada, Concluída,
Cancelada) · Prioridade(select: Urgente, Alta, Média, Baixa) · Prazo(date) ·
Tempo estimado (min)(number) · Tipo(select: Fazer, Cobrar) · Quem(rich_text) ·
Origem(url) · Projeto(select, options vazio) · Criada em(created_time) ·
Concluída em(date). REMOVE "Frente" do template novo (sinônimo mapeia frente→projeto
nas bases antigas). Cores nas options quando a API aceitar (gray/blue/yellow/red/
green/purple — checar payload de create; opcional).

### Upgrade aditivo (`src/tasks/upgrade.ts`)
`upgradeStandardTracker(accountId)` — SOMENTE para tracker cujo título é "Tarefas"
(criado pelo Zinom): GET schema → diff vs TARGET_PROPERTIES → PATCH
/v1/data_sources/{id} adicionando propriedades faltantes e options de select
faltantes (existentes preservadas com id; NUNCA remover/renomear nada).
IMPORTANTE: consultar via context7 o body exato do update de data source na
2025-09-03 (properties vs schema key) antes de implementar; cobrir com teste de
payload. Chamado por POST /portal/tasks/upgrade e no caminho de reuse do
createTaskTracker.

## Tools MCP (registradas para FRIEND **e** OWNER — hoje zinom_create_task é só friend)
Novo módulo `src/zinom-tasks-tools.ts` (ou expandir zinom-task-tool.ts):
1. `zinom_create_task` (retrocompatível) — params atuais + prioridade?, 
   tempo_estimado_min?, tipo? ('fazer'|'cobrar'), quem?, origem_url?, projeto?.
   `status` aceita canônico e literais legados ("A fazer" etc. → passthrough/sinônimo).
2. `zinom_list_tasks` — params: status? (array canônico), incluir_concluidas?
   (default false), prazo_ate?, prazo_de?, q?, limit?. Retorna {tasks, board,
   tracker_url}. Descrição ensina: use antes de criar (dedup), para "o que tenho
   pra fazer", cobranças (filtrar tipo='cobrar' no cliente), revisão do board.
3. `zinom_update_task` — params: task_id, + patch canônico (acima). Descrição:
   mover status (concluir, bloquear, iniciar), repriorizar, dar prazo, estimar
   tempo, registrar cobrança feita via nota_append.
4. `zinom_plan_context` — params: period_start (YYYY-MM-DD), period_end,
   timezone? (IANA, default America/Sao_Paulo), work_start? ("09:00"),
   work_end? ("19:00"), include_weekends? (false). Retorna:
   - events: ao vivo de TODAS as contas Google conectadas (list calendars +
     events na janela), normalizados {title, start, end, all_day, calendar},
     dedup por (titulo normalizado + start); fallback/união com eventos
     indexados do brain (source_type calendar, janela) quando não há Google.
   - free_slots: por dia, janelas de trabalho menos eventos timed (all-day não
     bloqueia), em minutos e horários locais do timezone (usar Intl p/ offset).
   - tasks: listTasks aberto agrupado por status (ordem backlog, todo,
     in_progress, blocked), com prioridade/prazo/estimativa; overdue em destaque.
   - totals: {free_min, abertos, estimado_min, overdue}.
   - guidance: 3 linhas fixas lembrando a IA: alocar por prazo+prioridade dentro
     dos slots, propor blocktime (create_calendar_event no Google; sem Google,
     zinom_create_task com data+fim), e atualizar status via zinom_update_task.
   Cap: janela máxima 35 dias. Não usa quota de busca.
5. `brain_today` — tasks passam a vir de listTasks (qualquer conta; remove o
   owner-only + id hardcoded de getTopTasks, que vira wrapper do adapter com o
   fallback do owner); events: dedup por (titulo normalizado + data + hora).

## INSTRUCTIONS (as duas superfícies: INSTRUCTIONS do owner em index.ts e
FRIEND_INSTRUCTIONS em mcp-account-config.ts) — nova seção "Fluxo de tarefas":
- Onde as tarefas vivem (base do usuário; tools zinom_*).
- Reunião→tarefas: ao pedir "extraia/identifique tarefas da reunião X": busque a
  reunião (brain_search source_type granola), identifique (a) o que a PESSOA deve
  fazer → tipo 'fazer'; (b) o que ela deve COBRAR de alguém → tipo 'cobrar' +
  quem; SEMPRE zinom_list_tasks com q antes de criar (dedup); origem_url = link
  da reunião; proponha a lista e confirme antes de criar em lote.
- Planejamento: dia/semana/mês → zinom_plan_context na janela; alocar respeitando
  prazo, prioridade e tempo_estimado vs free_slots; blocktime: Google quando
  houver, senão tarefa com data+fim; depois atualizar o board.
- Manter vivo: concluir/bloquear/repriorizar via zinom_update_task; revisão
  semanal = plan_context da semana + overdue + cobranças.

## Portal — backend
- POST /portal/tasks/upgrade → upgradeStandardTracker; {ok, added:[...]} ou erro.
- GET /portal/tasks/info → {configured, title, url, mapped:[campos canônicos
  mapeados], missing:[...], is_standard (título "Tarefas")}. Usa o adapter.
- POST /portal/tasks/use → valida o schema escolhido (loadTrackerProfile no id) e
  retorna o mesmo shape do info (a UI mostra o que mapeou/faltou). Continua
  gravando mesmo com missing (não bloqueia).
- Todos atrás de requireSession; account da sessão.

## Portal — frontend (app.html/app.js/v2.css)
1. **Onboarding (estado novo) vira 5 passos**: conta ✓ → conectar Notion/fontes →
   **"Onde suas tarefas vivem"** (inline: botão "Já tenho uma base no Notion" →
   detect→escolher; botão "Criar o Kanban padrão Zinom" → create; texto curto do
   que o template traz) → indexar → plugar IA. Reusar a fiação
   runDetectTasks/runCreateTasks/runUseTasks; o passo marca done quando
   activation.items.tasks.
2. **Checklist de ativação** (estado ativado): passo Tarefas ganha a mesma escolha
   dupla + quando configurado mostra nome/link da base (via /portal/tasks/info) e,
   se is_standard e missing>0, botão "Atualizar para o template novo" →
   /portal/tasks/upgrade.
3. **Guia — nova seção linear** `id="guia-tarefas"`, eyebrow "tarefas e
   planejamento", logo após "Conectar sua IA", em formato step-list de 4 capítulos:
   (1) "Onde suas tarefas vivem" — o template padrão campo a campo (tabela
   compacta), ou usar a própria base (o Zinom se adapta aos seus nomes de campos),
   CTA para configurar (Início/ativação);
   (2) "Da reunião para a tarefa" — explica fazer vs cobrar, prompt pronto:
   "Pega minha última reunião do Granola, identifica o que EU tenho que fazer e o
   que eu tenho que COBRAR de alguém, confere o que já existe no board e cria as
   tarefas que faltam com origem e prazo." + variação por reunião específica;
   (3) "Planejar dia, semana e mês" — explica a visão dupla (agenda + board),
   prompts prontos: dia ("Planeja meu dia de amanhã: cruza minha agenda com as
   tarefas abertas, sugere o que fazer em cada espaço livre e cria os blocktimes
   que eu aprovar"), semana ("Planeja minha semana: distribui as tarefas abertas
   pelos dias conforme prazo, prioridade e tempo estimado, respeitando minha
   agenda"), mês ("Faz o plano do mês: grandes entregas por semana, o que está
   atrasado e o que dá pra cortar");
   (4) "Manter o board vivo" — concluir/bloquear pelo chat, revisão semanal
   (prompt pronto), cobranças pendentes (prompt: "Lista minhas tarefas de cobrar,
   agrupadas por pessoa, com há quanto tempo estão paradas").
4. **Receitas**: nova categoria "tarefas" com 4 cards (extrair da reunião,
   cobranças pendentes, planejar semana, fechar o dia atualizando o board);
   manter as de planejamento existentes coerentes (mesmos textos dos prompts da
   seção do Guia — fonte única: constante JS compartilhada).
5. **Diagnóstico**: nova linha "Base de tarefas" (ok = configured; warn = não
   configurada com link p/ Início).
6. **Painel Claude Code reescrito** (prático e detalhado, step-list):
   (0) Pré-requisito: ter o Claude Code instalado — code-block
   `npm install -g @anthropic-ai/claude-code` + link docs.anthropic.com;
   (1) Gerar token (fiação atual, 1x);
   (2) Colar no terminal — comando gerado com `-s user` 
   (`claude mcp add -s user --transport http zinom https://zinom.ai/mcp --header
   "Authorization: Bearer <token>"`) + explicação de 1 linha: "-s user deixa o
   Zinom disponível em todas as suas pastas, não só na atual";
   (3) Verificar: `claude mcp list` deve mostrar "zinom ✓ connected"; dentro do
   Claude Code, `/mcp` lista as ferramentas;
   (4) Testar de verdade: "O que tem no meu cérebro?" e "O que tenho pra fazer
   esta semana?" (botões copiar);
   (5) Resolver problemas (mini-accordion ou lista): token revogado/perdido →
   gerar novo e `claude mcp remove zinom` + add de novo; "não conecta" → checar
   o header Authorization completo entre aspas; ferramentas não aparecem →
   reiniciar a sessão do Claude Code;
   (6) O que fazer agora → link para a seção Tarefas do Guia (#guia-tarefas).
   ChatGPT/Outra: ajuste leve mantendo estrutura atual.

## Owner
- `scripts/set-tasks-db.mts` (npm run set-tasks-db -- --account bruno --id <dsid>):
  grava no vault via setAccountSecret. Deploy: configurar bruno →
  30d07ba5-bee8-8040-841b-000b5d0b5d84.
- Registrar as tools zinom_* também na superfície do owner (BEARER_TOKEN/OAuth
  operador) — em index.ts onde registerTools(server) é chamado para owner.
- daily-briefing getTopTasks: usa adapter (conta owner) com fallback hardcoded;
  o cron 07:00 não pode quebrar.

## Fora de escopo (v1)
Extração automática server-side de tarefas (classifier) — fica assistant-driven;
campos people (Assignee); recorrência de tarefas; mutação de schema de bases que
não sejam o template "Tarefas"; UI de kanban no portal.

## Segurança
- accountId sempre do contexto/sessão. updateTask verifica parent do page id.
- PATCH de schema só no tracker configurado E título "Tarefas" (nunca em base
  arbitrária do usuário).
- Writes via tools auditados (auditWrite) como as demais writes.
- Nenhum segredo em log; tokens nunca no retorno das tools.

## Testes
- Unit table-driven do adapter: schema padrão novo, schema padrão antigo (select
  A fazer/Fazendo/Feito), schema do owner (status-type inglês, Priority
  Ultra/High, Tempo estimado min, Projeto multi_select), schema sem nada além de
  title (graceful: cria com título, lista sem status). Payloads de create/update.
  Slots livres do plan_context (eventos sobrepostos, all-day, fins de semana,
  timezone). Dedup de eventos. Upgrade diff/payload. Endpoints novos escopados.
- e2e: passo de tarefas no onboarding novo renderiza as duas escolhas (dev server
  responde no-notion → mensagem de conectar Notion primeiro); Guia contém
  #guia-tarefas e o comando claude mcp add com -s user.

## Deploy + verificação ao vivo
merge main → VPS (git pull, npm ci, build, pm2 restart) → npm run set-tasks-db
(bruno) → pela conexão MCP local: ciclo create→list→update→done→list numa tarefa
de teste (depois excluída/cancelada), zinom_plan_context da semana, e validação do
board real no Notion.
