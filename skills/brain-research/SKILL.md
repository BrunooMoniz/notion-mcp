---
name: brain-research
description: >-
  Pesquisa agêntica no segundo cérebro (Notion + Granola + Calendar via brain_search).
  Use quando a pergunta for ampla, multi-parte, de síntese ou de "estado atual"
  ("consolida tudo sobre X", "como estamos com Y", "o que mudou em Z", "o que ficou
  pendente comigo") — em vez de um lookup pontual. Decompõe a pergunta em várias
  buscas filtradas, deduplica e responde com citações + lacunas.
---

# brain-research — busca agêntica sobre o cérebro

O `brain_search` (tool MCP `mcp__notion-vps__brain_search`) faz UMA passada de
retrieval híbrido + rerank. Para perguntas amplas, você (o agente) deve orquestrar
VÁRIAS passadas e sintetizar. Não responda com uma busca só.

## Quando usar
- Síntese: "consolida o que rolou sobre Talos", "resumo da regulação da Nora".
- Estado-no-tempo: "qual o status atual do deal BRS", "o que mudou desde a última
  conversa com o Victor", "o que ficou pendente comigo".
- Conexão/briefing: "me prepara pra reunião com o Pinheiro Neto".
NÃO use para um lookup direto trivial (uma chamada de `brain_search` basta).

## Procedimento

1. **Decomponha** a pergunta em 2–5 sub-perguntas/ângulos. Ex.: "como estamos com a
   Nora?" → (a) regulação/BACEN, (b) produto/integração, (c) jurídico/Pinheiro Neto,
   (d) pendências/próximos passos.

2. **Busque cada ângulo** com `brain_search`, usando filtros pra precisão:
   - `query`: a sub-pergunta (frase natural, PT-BR).
   - `top_k`: 8–12.
   - `filters`: use o que ajudar — `workspace` (personal/globalcripto/nora),
     `source_type`/`exclude_source_type` (ex.: `exclude_source_type:"calendar"` pra
     tirar evento; `source_type:"granola"` pra reuniões), `pessoa`, `date_from`/`date_to`
     (pra "estado atual" / "o que mudou", filtre os últimos 30–90 dias).
   - Mantenha `rerank: true` (default).

3. **Junte e deduplique** os resultados por `notion_url` (mesma página aparece em
   vários chunks; conte uma vez). Olhe o `score` (relevância real, 0–1) — descarte o
   que vier muito abaixo do topo (ruído).

4. **Segundo salto se faltar**: se algum ângulo veio fraco ou aponta pra algo que
   você não tem detalhe, faça mais uma busca (ex.: o nome de uma pessoa/projeto que
   apareceu) ou puxe a página inteira com `notion_fetch(url)` pra detalhe.

5. **Sintetize** uma resposta direta e em PT-BR:
   - Comece pela conclusão/estado atual.
   - Organize por ângulo, **citando a fonte** de cada afirmação como link
     (`notion_url`) — o usuário precisa poder clicar e conferir.
   - Para "estado-no-tempo", ordene por data e diga o que é mais recente.
   - Termine com **"Lacunas/baixa confiança"**: o que NÃO achou ou está incerto
     (não invente — se o cérebro não tem, diga que não tem).

## Regras
- Cite sempre a origem (link). Nunca afirme sem fonte do cérebro.
- Respeite o escopo: se o usuário pediu de um workspace específico, filtre por ele.
- Prefira chunks com `score` alto e datas recentes para perguntas de estado.
- Seja honesto sobre lacunas — "o cérebro não registra isso" é uma resposta válida.
