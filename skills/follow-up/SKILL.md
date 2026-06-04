---
name: follow-up
description: >-
  Pós-reunião: a partir de uma nota do Granola / página de Reunião, extrai as
  DECISÕES e as TAREFAS acionáveis e propõe gravá-las no Cérebro (Decisões + Tasks
  Tracker) — sempre com confirmação antes de escrever. Use quando pedir "follow-up
  da reunião X", "o que ficou dessa reunião", "extrai as tarefas/decisões dessa
  call", "fechar a reunião com o Y".
---

# /follow-up — fechar reunião em decisões + tarefas

Transforma uma reunião num conjunto acionável, sem você reler tudo.

## Fontes/tools (já existem)
- Achar a reunião: `mcp__notion-vps__brain_search` (filtro `source_type:"granola"` ou `db`) ou
  `mcp__notion-vps__notion_fetch` se já tiver a URL. Se o usuário não disser qual, pegue a mais
  recente relevante e CONFIRME ("é essa: <título/data>?").
- Tasks Tracker (workspace `personal`): `data_source_id 30d07ba5-bee8-8040-841b-000b5d0b5d84`
  (campos: Task name, Status, Priority, Due date, **Tempo estimado** (min), Projeto).
- DB Decisões: descubra via `mcp__notion-vps__notion_search` (workspace `personal`, query "Decisões").
- Escrita: `mcp__notion-vps__notion_create_page` / `notion_update_page`.

## Procedimento
1. **Carregue** a reunião (texto/summary). 
2. **Extraia**, em PT-BR:
   - **Decisões** tomadas (o que foi decidido + contexto curto).
   - **Tarefas** acionáveis (verbo no início, responsável se houver, prazo se mencionado, projeto,
     e uma estimativa de **Tempo estimado** em minutos quando der pra inferir).
   - **Pendências/perguntas em aberto** (não viram task ainda, mas precisam de resposta).
3. **Apresente** a lista pro usuário revisar (não grave ainda). Marque o que é decisão vs tarefa.
4. **Grave só após "ok"** (confirm-gated):
   - Cada tarefa → nova página no Tasks Tracker (Status "To-do", Priority/Projeto/Tempo estimado/Due
     quando aplicável). Parent: `{type:"database_id", database_id: <container do Tasks Tracker>}`.
   - Cada decisão → nova página na DB Decisões (com contexto + link da reunião).
   - Mostre o que vai criar ANTES; só então crie. Reporte os links criados.

## Regras
- Nada de gravar sem confirmação. Não invente tarefas que a reunião não sustenta.
- Vincule sempre à reunião de origem (link). Estimativas de tempo: marque "(estimado)".
- PT-BR, conciso.
