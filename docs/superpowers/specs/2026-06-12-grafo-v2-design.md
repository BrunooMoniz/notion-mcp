# Grafo v2: agrupamentos com sentido e física viva (2026-06-12)

Pedido do dono do produto: "o grafo está feio, pouco funcional; precisamos de
critérios e atalhos para agrupar (cronológico, por projeto, por semelhança);
algo legal e leve de visualizar, com física menos travada".

## Dores de usuário que o grafo resolve

| Dor | Resposta no grafo |
|---|---|
| "O que está acontecendo agora no meu mundo?" | Preset **Recentes**: só o que foi mencionado nos últimos N dias, tamanho por atividade recente |
| "Quero ver tudo em volta de um projeto" | Preset **Projetos** + foco com vizinhança e documentos |
| "Quem se conecta com quem?" | Preset **Pessoas** (e Empresas), arestas por co-ocorrência |
| "O que é velho e o que é novo aqui?" | Preset **Cronologia**: cor dos nós por recência (semana/mês/3 meses/antigo) |
| "Que grupos existem que eu não nomeei?" | **Comunidades**: cor por componente conectado (semelhança estrutural) |
| "O grafo é poluído e duro" | Física contínua (cola), fade de não-vizinhos no hover, labels inteligentes, transições incrementais sem reconstruir |

## Contrato de API (retrocompatível)

`GET /portal/brain/graph` ganha parâmetros opcionais:
- `days=<int>`: janela temporal. Menções só contam se a data do documento
  (`COALESCE(metadata->>'data', source_updated::date)` do chunk) está na
  janela. Afeta seleção dos top nós, weight dos nós e weight das arestas.
- `group_by=community|type|none` (default none): backend devolve `group` por
  nó. `community` = componentes conectados do subgrafo induzido (union-find em
  memória sobre as arestas já computadas; determinístico, maiores componentes
  primeiro: group 0, 1, 2...). `type` = pessoa/empresa/projeto.
- `min_edge_weight=<int>` (default 2, mínimo 1): expõe o HAVING atual.

Resposta: nós ganham `group` (int|string|null), `recent` (menções na janela,
= weight quando days presente) e `last_seen` (data ISO do documento mais
recente que menciona a entidade — sempre presente, independe de days).
Arestas inalteradas (`a`, `b`, `weight`). `mode`, `type`, `entity_ids`,
`include_docs`, `max_nodes` continuam como hoje.

## Front: presets e física

Chips de preset acima do canvas (substituem nada, são atalhos que combinam
parâmetros):
- **Visão geral**: overview + `group_by=community` (cor por comunidade).
- **Recentes**: `days=30`, tamanho por `recent`.
- **Cronologia**: overview, cor por buckets de `last_seen` (≤7d, ≤30d, ≤90d,
  mais antigo) com legenda própria.
- **Pessoas** / **Empresas** / **Projetos**: `type=...`.
Seletor de período (7d / 30d / 90d / Tudo) aplicável a qualquer preset (manda
`days`). Busca de entidade (usa GET /portal/brain/entities?q=) que centraliza
e destaca o nó.

Física e leveza:
- **cytoscape-cola** (vendorar `cola.min.js` + `cytoscape-cola.js` em
  portal/vendor, registrar como o fcose) com simulação viva curta: layout
  roda animado, nós podem ser arrastados com mola; botão "congelar/soltar".
  Fallback automático para o fcose atual se os vendors faltarem.
- **Atualização incremental**: trocar preset/filtro NÃO destrói o cy; faz diff
  de elementos (add/remove) e re-layout animado. `_cy.destroy()` só ao sair da
  view.
- Labels: sempre visíveis para os top ~8 nós por weight; demais aparecem no
  zoom ou hover (regra atual refinada). Hover: vizinhança em destaque, resto
  com fade. Arestas com opacidade proporcional ao weight.
- Paleta: manter cores de tipo atuais; comunidades usam paleta categórica de
  8 cores reaproveitando tokens do portal; bucket de cronologia usa rampa de
  verde (recente) a cinza (antigo).
- Painel lateral ganha "últimos documentos" com data (usa
  /portal/brain/entities/:id/documents) quando um nó é selecionado.

## Critérios de aceite
1. Unit: graph-storage com pool injetado cobre `days` (weights na janela),
   `group_by=community` (union-find determinístico), `min_edge_weight`,
   `last_seen` no shape; rota valida/clampa params. `npm test` verde.
2. Front: `node --check` ok; Playwright: chips renderizam, clique em preset
   refaz o GET com os params certos (interceptação de rota), empty state
   continua, screenshot do grafo salvo como artefato para revisão visual.
3. Retrocompatível: chamadas sem os novos params devolvem o shape atual
   (+ campos novos), front antigo continuaria funcionando.
4. Performance: nenhuma query nova sem filtro por account_id; caps mantidos.
