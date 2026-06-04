---
name: decisao
description: >-
  Registra uma DECISÃO estruturada na DB Decisões do Cérebro (contexto, opções
  consideradas, escolha, data, projeto/frente). Use quando o usuário disser
  "registra a decisão de X", "decidi Y", "loga essa decisão", "anota que vamos
  fazer Z". Mantém o histórico de decisões pesquisável depois.
---

# /decisao — registrar uma decisão

Captura uma decisão de forma estruturada pra ela virar memória pesquisável (e
aparecer depois em /status-deal, briefings, etc.).

## Tools (já existem)
- DB Decisões: descubra o `data_source_id` via `mcp__notion-vps__notion_search`
  (workspace `personal`, query "Decisões"); confira o schema com
  `mcp__notion-vps__notion_get_data_source_schema` antes de gravar (nomes de
  propriedades podem variar — ex.: Status/Projeto/Fonte/Data).
- Escrita: `mcp__notion-vps__notion_create_page`.
- Contexto (opcional): `mcp__notion-vps__brain_search` pra puxar o que motivou a decisão.

## Procedimento
1. **Monte a decisão** a partir do que o usuário disse (e, se útil, contexto do `brain_search`):
   - **Título**: a decisão em uma frase ("Migrar Parfin → Talos até Dez/2026").
   - **Contexto**: por que (1–3 linhas).
   - **Opções consideradas** (se houver) e **por que essa**.
   - **Projeto/Frente** (Global Cripto / Nora / Pessoal / etc.) e **Data** (hoje, salvo dito).
   - **Fonte** (reunião/conversa) com link, se aplicável.
2. **Confirme** com o usuário o resumo (1 linha) antes de gravar.
3. **Grave** após "ok": crie a página na DB Decisões mapeando os campos pro schema real
   (use os nomes que vierem do schema). Parent `{type:"database_id", database_id: <container>}`.
   Reporte o link criado.

## Regras
- Mapeie os campos pelo schema REAL da DB (não chute nomes de propriedade).
- Não grave sem confirmação. Seja fiel ao que foi decidido (não amplie o escopo).
- PT-BR, direto.
