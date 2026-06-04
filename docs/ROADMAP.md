# Roadmap — Segundo Cérebro (notion-mcp)

> Plano de execução vivo. Confiança → valor → escala → freemium. Mantido por fases; cada item
> vira PR no `dev` → `main` (protegido, CI verde). Origem: avaliação de 2026-06-04.

## Contexto

Backend de retrieval sólido (híbrido + reranker + HNSW + full-text PT-BR + escopo por workspace,
multi-fonte Notion/Granola/Calendar-iCal). O que falta não é o motor — é **confiabilidade
operacional, UX de uso/instalação, e as features de maior valor (agêntica, planejamento de dia,
proatividade)**. Objetivo: cérebro confiável, observável, fácil de operar, com as features de valor,
pronto para abrir como OSS e depois ganhar uma camada freemium hospedada.

## Princípios & guard-rails

1. Confiança antes de features (observabilidade + eval + CI + backup antes de write-back autônomo).
2. Tudo via PR. `main` protegido. `feat/*`/trabalho em `dev` → PR → `main`. CI verde obrigatório.
3. Backup antes de migração; eval antes/depois de mudanças de retrieval.
4. Preservar a essência: MCP-nativo, VPS única, Notion como PKM, PT-BR, reuso de infra. Sem rewrite.
5. Sem scope creep. Escritas destrutivas/autônomas confirm-gated até a Fase 0 fechar.

## Fase 0 — Confiança & DX de operação (dias 1–2)

- **F0.1 Observabilidade** — tabela `status_runs`; persistir `IndexerStats`/`ClassifierStats`;
  endpoint `GET /status` (última sync/idade/contagem/erro por fonte); `scripts/doctor.mts`
  (`npm run doctor`) valida Postgres/extensões/Voyage/cada Notion token/cada iCal/Google; alerta de
  fonte parada (loga `[ALERT]` + página Notion "Saúde do Cérebro"). Arquivos: `src/index.ts`,
  `src/rag/indexer.ts`, `src/classifier/notion-classifier.ts`, `scripts/init-db.sql`.
- **F0.2 Eval baseline** — rascunhar `scripts/eval/golden-set.jsonl` (~40 Qs PT-BR), Bruno valida,
  `npm run eval` → congelar `eval-results/baseline-f0.json`.
- **F0.3 CI** — `.github/workflows/ci.yml`: `npm ci` + build + test em PR; check obrigatório no `main`.
- **F0.4 Segurança & resiliência** — OAuth TTL curto + refresh-token + revogação (`src/oauth.ts`);
  `chmod 600` em `data/*`; backup `pg_dump` diário + runbook; reemitir `NOTION_NORA_TOKEN`.
- **F0.5 Migration runner** — `scripts/migrate.mts` + `schema_migrations`; mover SQL p/ `scripts/migrations/`.

## Fase 1 — Inteligência & valor diário (dias 3–5)

- **F1.1** Skill `brain_research` (decompõe→N buscas→sintetiza com citações) + contextual retrieval
  barato (header determinístico por chunk: breadcrumb+data+atendentes+workspace). Medir no eval.
- **F1.2** Planejador de dia por capacidade (esforço × tempo livre do Calendar; write-back no Tasks
  Tracker, confirm-gated → autônomo após F0). Skill `/meu-dia`.
- **F1.3** Briefings pré-reunião proativos (cron no servidor → página Notion "Hoje"; canal default).
- **F1.4** Skills no repo (`skills/`) + atalhos `/prep-reuniao`, `/follow-up`, `/decisao`, `/status-deal`.
- **F1.5** Fixes: recorrência iCal (próxima ocorrência), dedup de quase-duplicados no `brain_search`.

## Fase 2 — Escala, diferenciação & resiliência (dias 6–8)

- **F2.1** Docker compose (app + postgres+pgvector) + migrate runner → `docker compose up` roda.
- **F2.2** Framework de conectores (abstração `Source`) + 1 nova fonte (web capture ou Slack).
- **F2.3** (Opcional, se eval/uso justificar) fatos temporais leves (`brain_facts`) no Postgres.
- **F2.4** Resiliência: runbook SPOF, rotação de segredos, restore de backup testado.
- **F2.5** Mini-dashboard `/status` (HTML simples).

## Fase 3 — Freemium / onboarding simplificado (FUTURO — spec próprio)

Onboarding via OAuth do Notion (sem `.env`/psql/VPS própria); landing/onboarding em Vercel/Cloudflare
(free/cheap); MCP+brain+indexer na VPS; multi-tenant leve (workspace = unidade de isolamento, já é a
base); limites no free tier. **Não detalhado agora.** Costuras a preservar: evitar hard-coding de
usuário único; config por env já aponta pra multi-config. Spec dedicado ao fim da Fase 2.

## Decisões (defaults) & o que preciso do Bruno

- Ordem: F0 → F1 → F2 → F3 (trust-first). Canal de push default: página Notion "Hoje".
- Planejador confirm-gated até F0 fechar, depois autônomo.
- Bruno: reemitir `NOTION_NORA_TOKEN` (F0.4); validar golden set ~15min (F0.2); confirmar canal de push (F1.3);
  trocar senha root + resetar links iCal (segurança).

## Verificação por fase

- **F0:** `/status` lista fontes; `npm run doctor` verde; `npm run eval` imprime baseline; CI bloqueia PR ruim; backup diário.
- **F1:** eval ≥ baseline; `/meu-dia` gera plano e grava (com OK); página "Hoje" preenchida.
- **F2:** `docker compose up` do zero; nova fonte indexa; restore de backup testado.
