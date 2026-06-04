---
name: meu-dia
description: >-
  Planeja o dia do Bruno por CAPACIDADE — cruza o tempo livre real do calendário
  com as tarefas abertas (e o esforço estimado de cada uma) pra montar um dia
  REALISTA: nem tarefas demais (sobrecarga), nem de menos (tempo ocioso). Use
  quando pedir "meu dia", "planeja meu dia", "o que faço hoje", "tô sobrecarregado?",
  "o que dá pra fazer hoje", "monta minha semana" ou variações. Também serve de
  cutucão reativo ("terça tá lotada?").
---

# /meu-dia — planejador de dia por capacidade

Objetivo central do Bruno: **não colocar tarefas demais nem de menos no dia.**
A regra é simples: *tempo livre real (do calendário) ≥ soma do esforço das tarefas escolhidas.*

## Fontes (tools que já existem)

- **Tarefas** — Notion `personal`, Tasks Tracker:
  - `data_source_id`: `30d07ba5-bee8-8040-841b-000b5d0b5d84`
  - Use `mcp__notion-vps__notion_query_data_source` (workspace `personal`).
  - Campos: **Task name** (title), **Status** (status), **Priority** (select: Ultra/High/Medium/Low),
    **Due date** (date), **Tempo estimado** (number, MINUTOS), **Projeto** (multi_select: Moniz/Moneth/Firebit/Global Cripto/Nora), **Description**.
  - "Aberta" = Status ∈ {Backlog, To-do, Blocked, In progress}; ignore {Done, Canceled}.
- **Calendário (tempo livre)** — `mcp__notion-vps__brain_search` com `filters.source_type:"calendar"` e
  `date_from`/`date_to` = o dia em questão. Isso traz TODOS os calendários (Pessoal, Global Cripto, etc.)
  unificados. (No claude.ai dá pra cruzar com o conector Google ao vivo se quiser confirmar.)

## Procedimento

1. **Defina o dia e a janela de trabalho.** Hoje, salvo o usuário dizer outro dia. Janela padrão
   **09:00–18:00** (≈ 540 min) — ajuste se ele já tiver dito o horário dele.
2. **Some o tempo OCUPADO** pelos eventos do calendário do dia (busque com `source_type:"calendar"` +
   data). `tempo_livre = janela − reuniões − um buffer de ~15% pra imprevisto/contexto-switch`.
3. **Puxe as tarefas abertas** (query no Tasks Tracker, Status aberto), ordenadas por: vencidas/Due hoje
   primeiro, depois Priority (Ultra>High>Medium>Low). Para cada, leia **Tempo estimado**.
   - Tarefa **sem Tempo estimado** → não dá pra encaixar com precisão: estime você um valor plausível
     (e marque "estimado por mim") ou pergunte ao Bruno; não ignore silenciosamente.
4. **Encaixe por capacidade:**
   - Comece pelos **inadiáveis** (vencidos / Due hoje / Ultra-High). Some o esforço.
   - Se os inadiáveis **já estouram** o tempo livre → **sinalize sobrecarga**: mostre quanto passou e
     proponha o que **adiar** (menor prioridade / Due mais folgado) pra caber.
   - Se ainda **sobra** tempo livre → **puxe** as próximas por prioridade até preencher; se sobrar muito,
     sugira puxar 1–2 do Backlog.
5. **Apresente o plano** (PT-BR, direto):
   - Linha de capacidade: `Tempo livre hoje: Xh Ymin · Tarefas escolhidas: Zmin · folga/estouro: …`.
   - Lista ordenada das tarefas do dia (nome · projeto · prioridade · estimativa · due).
   - "Fica de fora hoje (e por quê)" + sugestão de quando.
6. **Write-back (confirm-gated):** SÓ depois do "ok" do Bruno, atualize as tarefas escolhidas via
   `mcp__notion-vps__notion_update_page` — ex.: mover Status p/ "To-do"/"In progress", ajustar Due date
   dos adiados. Mostre o que vai mudar ANTES e espere o OK. Nunca grave sem confirmação.

## Regras
- **Capacidade é a estrela:** se não cabe, diga que não cabe e corte — não empilhe.
- Respeite os inadiáveis (vencido/Due hoje) acima de tudo.
- Tarefas sem estimativa: estime ou pergunte, nunca finja precisão.
- Seja honesto e específico (minutos reais, nomes reais, links das tarefas).
- Escrita só com confirmação explícita. Um resumo de 1 linha do que mudou ao final.
