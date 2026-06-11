# Zinom.ai — Rotina de Ativação (onboarding pós-conexão)

**Data:** 2026-06-06
**Repo de código:** `BrunooMoniz/notion-mcp` (working copy em `.context/notion-mcp/`)
**Status:** spec aprovada no brainstorming (Bruno, 2026-06-06). Próximo passo: plano de implementação.

## Problema

Hoje o portal do Zinom (`portal/app.html` + `src/portal/*`) faz só *plumbing*: o amigo
conecta as fontes (Notion via OAuth/PAT, calendários iCal, chave Granola), clica
"Indexar meu Zinom agora", gera o token MCP e pluga no assistente. O fluxo termina aí.

Conectar não é usar bem. O gap real de ativação:

- **Features dependem de comportamento/estrutura que um Notion novo não tem.** O
  planejador de dia (`/meu-dia`) precisa de uma DB de tarefas estruturada (com `Tempo
  estimado`, status, prazo). O Notion do operador (Bruno) tem; o de um amigo novo não.
  Sem isso, o recurso simplesmente não funciona pra ele.
- **A pessoa não sabe como tirar valor.** Não sabe como perguntar pro cérebro, nem que
  toda reunião gravada no Granola vira memória, nem que a agenda já está visível.

A "rotina de perguntas" que o produto precisa não é só texto educativo: ela fecha o
gap de ativação de verdade (incluindo montar estrutura no Notion da pessoa quando falta).

## Objetivo e critério de sucesso

Uma rotina **one-time** que, logo após a primeira indexação, leva o amigo de
"fontes conectadas" a "primeiro valor real": tarefas estruturadas no Notion +
pessoa sabendo fazer a primeira pergunta ao Zinom no assistente dela.

**Critério de pronto (verificável por máquina):** conta nova sem task tracker →
checklist oferece criar → cria a DB com o schema esperado → `tasks_db_id` gravado na
conta → checklist marca o item como ✅. Coberto por testes unit + isolamento por
`account_id` + E2E Playwright. `tsc` limpo, suíte verde, boot de produção ok.

## Decisões travadas (brainstorming, 2026-06-06)

- **Q1 — explicar vs montar: HÍBRIDO (C).** Detecta o que já existe e adapta; se não
  existe, oferece montar pra pessoa. Nunca escreve sem confirmação.
- **Q2 — onde vive: HÍBRIDO (C).** Portal = rampa mecânica e descobrível (checklist
  de ativação). Assistente = casa, onde o ensino "vivo" e o uau acontecem (handoff).
- **Q3 — escopo: 4 itens, one-time.** Tarefas, Pergunte-ao-Zinom, Granola, Calendário.
  Recorrência ("faz 3 dias que você não registra tarefa") é feature separada, depois.
- **D1 — onde criar a DB:** o Zinom cria uma página-mãe **"🧠 Zinom"** no workspace da
  pessoa e coloca a DB "Tarefas" dentro. Contido, descobrível, não bagunça a estrutura.
- **D2 — detecção conservadora:** busca DB com (campo status-like + campo date-like) OU
  nome casando `tarefa|task|to-?do|afazer`. Na dúvida, **pergunta** (não assume). Nunca
  escreve sem confirmação explícita da pessoa no portal.
- **D3 — handoff MVP:** portal entrega prompts prontos (copy-paste) + "como usar em
  30s". Sem código novo no assistente no MVP. Frase de boas-vindas nas `INSTRUCTIONS`
  e skill de onboarding conversacional ficam pra depois.

## Fora de escopo (deliberado)

Briefing diário automático, fechamento semanal, revisitar/spaced-repetition, write-back
avançado a partir do chat, cutucões recorrentes, skill de onboarding conversacional,
boas-vindas nas `INSTRUCTIONS` do MCP. Tudo isso vale mais depois que os 4 itens de
ativação estiverem de pé; alguns são de tier pago.

## Fluxo ponta a ponta

```
Portal: conecta fontes → "Indexar meu Zinom" → ✅ indexado
        ↓
[NOVO] Checklist de Ativação (aparece após a 1ª indexação; some quando os 4 ✅)
   1. Tarefas no Notion   → detecta / cria        [destrava /meu-dia]
   2. Granola             → confirma + 1 frase     [já tem a chave]
   3. Calendário          → confirma conectado
   4. Pergunte ao Zinom   → prompts prontos + handoff
        ↓
Assistente (Claude): pessoa cola a 1ª pergunta e vê o cérebro respondendo
```

## Componentes

### 1. Detector / criador de task tracker (backend)

Módulo novo, isolado por `account_id`, usando o token Notion da conta já no vault.

**Detecção** (`detectTaskTracker(accountId)`):
- Lista data sources / DBs do workspace da conta.
- Marca como candidata a DB que tenha **campo status-like** (`status` ou select com
  opções tipo a fazer/fazendo/feito) **e campo date-like**, OU cujo nome case o regex
  `tarefa|task|to-?do|afazer` (case/acento-insensível).
- Retorna `{ status: 'none' | 'one' | 'many', candidates: [...] }`.

**Adaptação** (quando a pessoa confirma uma candidata existente):
- Compara o schema da candidata com o schema-alvo e **adiciona apenas os campos que
  faltam** (ex.: `Tempo estimado`). Adicionar coluna é não-destrutivo — nunca remove
  nem renomeia nada do que já existe.

**Criação** (`createTaskTracker(accountId)`, só com confirmação):
- Garante a página-mãe "🧠 Zinom" no workspace (cria se não existir; idempotente).
- Cria a DB "Tarefas" dentro dela com o schema-alvo.

**Schema-alvo da DB "Tarefas"** (o mínimo que o `/meu-dia` espera):
- `Nome` (title)
- `Status` (select/status: A fazer / Fazendo / Feito)
- `Prazo` (date)
- `Tempo estimado` (number, unidade horas)
- `Frente` (select)

**Persistência:** grava `tasks_db_id` na conta. É o gancho para o planejador resolver a
DB *daquela* conta no futuro. **Importante:** hoje o `/meu-dia` é uma **skill** (markdown
em `skills/meu-dia/SKILL.md`) com o `data_source_id` do operador **hardcoded**
(`30d07ba5-…`, idem em `src/briefing/daily-briefing.ts:31` e nas skills `follow-up`/
`status-deal`). Tornar o planejador account-aware envolve a distribuição de skills por
conta, que é uma questão em aberto separada. **Por isso, no MVP, o consumo do
`tasks_db_id` pelo `/meu-dia` fica FORA de escopo** — a rotina apenas detecta/cria a
estrutura e persiste o `tasks_db_id`; ligar o planejador a ele é trabalho posterior.

### 2. Checklist de ativação (portal — backend + front)

Estado por conta: `activation_state` (JSON com os 4 itens + se o checklist foi
concluído/dispensado). O front lê via `/portal/me` (ou rota nova) e renderiza o
checklist abaixo do bloco de indexação, **só enquanto não concluído**.

Itens:
1. **Tarefas** — chama o detector; renderiza um dos caminhos (achou 1 → "usar essa?";
   achou várias → escolher; nenhuma → "criar pra mim"). Ação confirma → cria/adapta →
   marca ✅ + grava `tasks_db_id`.
2. **Granola** — se tem chave no vault → ✅ + frase "toda reunião gravada no Granola
   vira memória do Zinom". Senão → aponta pro card de conectar Granola.
3. **Calendário** — se tem iCal → ✅ + frase "o Zinom já enxerga sua agenda". Senão →
   aponta pro card de iCal.
4. **Pergunte ao Zinom** — sempre por último. 2-3 prompts prontos pra copiar,
   calibrados pelo que a conta conectou. Marca ✅ quando a pessoa expande/copia (ação
   leve; é o handoff, não dá pra verificar do lado de cá que ela usou).

### 3. Handoff pro assistente (MVP)

Sem código novo no assistente. O item 4 do checklist mostra:
- Como adicionar/abrir o Zinom no assistente (reusa o que o painel já ensina).
- 2-3 prompts prontos: ex. "o que rolou nas minhas últimas reuniões?", "planeje meu
  dia", "o que ficou pendente sobre [projeto]?". Calibrados: só mostra "planeje meu
  dia" depois que Tarefas está ✅.
- Um "como usar em 30s".

## Dados / persistência (aditivo)

- `tasks_db_id` por conta (coluna em `account` ou kind no vault).
- `activation_state` por conta (JSON: estado dos 4 itens + concluído/dispensado).

Tudo aditivo; nada do existente é reescrito. Migração nova segue o padrão
`scripts/migrations/000X_*.sql` + runner idempotente `npm run migrate`.

## Isolamento e segurança (gate inegociável)

- Toda leitura/escrita no Notion usa o token **da conta** (vault), resolvido por
  `account_id`. Nunca toca o Notion de outra conta nem os workspaces do operador.
- Criação/adaptação no Notion **só com confirmação explícita** da pessoa no portal.
- Adaptar candidata existente = só **adicionar** campos faltantes; nunca remover,
  renomear ou apagar.
- Teste de isolamento obrigatório (conta A não enxerga/escreve no Notion da conta B).

## Critério de pronto (detalhado)

- Unit: detector retorna `none`/`one`/`many` corretamente; criador monta o schema-alvo;
  adaptador adiciona só o que falta (não-destrutivo).
- Isolamento: criação/leitura usam `account_id` certo; conta A ≠ conta B.
- E2E Playwright: conta nova sem Tarefas → checklist oferece criar → cria →
  `tasks_db_id` gravado → item marca ✅; checklist some quando os 4 estão ✅.
- `tsc` limpo + suíte unit verde + boot do `index.ts` de produção verificado.

## Riscos / pontos de atenção

- **Variabilidade do Notion alheio:** schema/permissões imprevisíveis. Mitigado pela
  detecção conservadora (pergunta na dúvida) e por nunca escrever sem confirmar.
- **`/meu-dia` multi-tenant (fora do MVP):** o `/meu-dia` é uma skill com `data_source_id`
  hardcoded do operador (`skills/meu-dia/SKILL.md`; idem `daily-briefing.ts:31`,
  `follow-up`, `status-deal`). Esta feature introduz e persiste `tasks_db_id` por conta,
  mas **não** liga o planejador a ele no MVP (depende de distribuição de skills por
  conta, em aberto). Fica como trabalho posterior, desbloqueado pelo `tasks_db_id`.
- **Marcar item 4 como ✅:** não dá pra provar do backend que a pessoa usou o assistente;
  o ✅ é por ação leve no portal (expandir/copiar). Aceito (é handoff).
