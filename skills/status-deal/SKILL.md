---
name: status-deal
description: >-
  Estado atual de um deal / projeto / parceiro, cruzando reuniões, decisões,
  insights e tarefas recentes do Cérebro — com peso de recência. Use quando pedir
  "qual o status do deal X", "como está Y", "onde paramos com o parceiro Z", "o que
  mudou em W", "me atualiza sobre <projeto>". Responde estado + últimos avanços +
  pendências + próximos passos, com fontes.
---

# /status-deal — estado atual de um deal/projeto

Aplica a busca agêntica (ver [[brain-research]]) a UM alvo, priorizando o que é
RECENTE, pra responder "onde estamos com isso agora".

## Procedimento
1. **Identifique o alvo** (deal/projeto/parceiro: Talos, BRS, Pinheiro Neto, Firebit, etc.).
2. **Busque com peso de recência** via `mcp__notion-vps__brain_search`:
   - 1 busca ampla pelo alvo + 2–3 sub-buscas (ex.: "<alvo> decisão", "<alvo> pendência/próximos passos",
     "<alvo> última reunião"), com `filters.date_from` ~ últimos 60–90 dias e `exclude_source_type:"calendar"`.
   - Considere também as **Decisões** registradas sobre o alvo (db Decisões) e **tarefas abertas**
     do Tasks Tracker (`data_source_id 30d07ba5-bee8-8040-841b-000b5d0b5d84`) ligadas ao Projeto.
3. **Deduplique** por url e ordene por data (mais recente primeiro).
4. **Responda** em PT-BR, nesta forma:
   - **Estado atual** (1 parágrafo: onde está hoje).
   - **Últimos avanços** (bullets datados, mais recentes no topo, com link).
   - **Decisões em vigor** (se houver).
   - **Pendências / próximos passos** (tarefas abertas + o que está travado).
   - **Lacunas**: o que o cérebro não registra / está incerto (não invente).

## Regras
- Recência manda: priorize itens recentes; sinalize quando a informação é antiga.
- Cite fontes (links). Honesto sobre o que falta.
- Read-only por padrão (não grava nada). PT-BR.
