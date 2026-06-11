# Second Brain RAG — Design

**Data:** 2026-05-04
**Sub-projeto:** C — Memória de busca / RAG sobre o Cérebro
**Contexto:** primeiro de 4 sub-projetos da expansão do "segundo cérebro" do Bruno (ordem: C > A > D > B). Este doc cobre apenas C.

## Problema

O Cérebro do Bruno no Notion (Diário Semanal, Reuniões, Insights, Decisões, Projetos, Pessoas, Organizações, Academia, Tasks Tracker) já tem volume suficiente pra que a busca nativa do Notion (keyword, page-level) seja insuficiente. Casos típicos que o sistema atual não cobre bem:

- **Lookup pontual:** "qual era o número que combinei com Z?", "o que ficou decidido sobre X?"
- **Síntese narrativa:** "consolida tudo que aconteceu sobre stablecoin BRS nos últimos 3 meses"
- **Conexão / descoberta:** "que reuniões/insights se conectam com o tópico Talos?"

Os 3 casos têm peso comparável (resposta do user à pergunta de uso dominante: "D — mix dos três").

## Escopo

### Em escopo (MVP)

- **Fontes indexadas:** Notion (3 workspaces: `personal`, `globalcripto`, `nora`) + Granola summaries + Google Calendar
- **Interface:** nova tool MCP `brain_search` exposta pelo `notion-vps` existente
- **Storage:** Postgres + pgvector na mesma VPS (`124.198.128.68`)
- **Embedding:** Voyage AI `voyage-3-large` (output_dim=1024); plano B `cohere/embed-v4` se qualidade decepcionar em PT-BR

### Fora de escopo (deixado pros sub-projetos A/D/B)

- Captura de Slack, email, web highlights, voice notes (sub-projeto A)
- Auto-classificação, auto-relations, spaced repetition de insights (D)
- Cadência diária/mensal/trimestral (B)
- UI web dedicada (eventual evolução; o desenho permite, mas não no MVP)
- Granola transcripts (não disponível no plano freemium atual do Bruno)

## Arquitetura

```
                   ┌─────────────────────────────────────┐
                   │           VPS (já existe)           │
                   │                                     │
  Notion API ─────▶│  ┌──────────┐    ┌──────────────┐  │
  Granola API ────▶│  │ indexer  │───▶│   Postgres   │  │
  Google Cal ─────▶│  │ (cron 1h)│    │  + pgvector  │  │
                   │  └──────────┘    │  + tsvector  │  │
                   │       │          │              │  │
                   │       ▼          │  brain_chunks│  │
                   │   Voyage AI ────▶│              │  │
                   │  (embed-large)   └──────┬───────┘  │
                   │                         │          │
                   │  ┌──────────────────┐   │          │
  Claude.ai  ─────▶│  │ notion-mcp       │◀──┘          │
  Claude Code ────▶│  │ + brain_search   │              │
                   │  │   tool (new)     │              │
                   │  └──────────────────┘              │
                   └─────────────────────────────────────┘
```

### Princípios de design

1. **Reaproveitar infraestrutura existente** — mesma VPS, mesmo Tailscale, mesmo PM2, mesmo repo. Sem nova máquina, sem novo serviço externo recorrente.
2. **Single tool, parâmetros ricos** — `brain_search` cobre os 3 casos de uso via `mode` + `filters`. Síntese fica com o Claude que chamou (não no MCP).
3. **Embedding model trocável** — abstração de embedding atrás de uma interface; trocar de Voyage pra Cohere é uma var de ambiente + reindex.
4. **Hybrid retrieval** — vetor (semântico) + tsvector (keyword) combinados via Reciprocal Rank Fusion. Captura sentido E match exato (termos como "BRS", "Talos", "C212/STA" precisam aparecer mesmo em queries mal formuladas).

## Componentes

Tudo dentro do repo `notion-mcp` (https://github.com/BrunooMoniz/notion-mcp).

### `src/rag/indexer.ts`
Orquestra o delta sync:
1. Lê `sync_state` pra cada `source_type`
2. Pra cada source, pega itens com `last_edited_time > last_sync` (Notion via `notion_query_database` por DB; Granola via `list_meetings`; Calendar via `list_events`)
3. Pra cada item: extrai texto, chunka, embeda, upsert
4. Atualiza `sync_state.last_sync_at = now()`

Roda como processo PM2 separado (`brain-indexer`) com `node-cron` interno disparando a cada 1h.

### `src/rag/chunker.ts`
Split semântico baseado em estrutura do conteúdo:
- **Notion pages:** percorre blocks; agrupa blocks consecutivos até atingir ~500 tokens; respeita boundaries (heading começa novo chunk; lista não quebra no meio).
- **Granola summaries:** geralmente já são curtos (1-3 parágrafos); cada summary vira 1-2 chunks.
- **Calendar events:** título + descrição + atendees → 1 chunk por evento.
- Overlap de 50 tokens entre chunks consecutivos pra preservar contexto.

### `src/rag/embeddings.ts`
Wrapper Voyage AI com:
- Cache local: `Map<sha256(text), vector>` em memória + tabela `embedding_cache(text_hash, embedding)` no Postgres pra persistência. Antes de chamar API, checa cache.
- Batch API calls (até 128 inputs por request) pra reduzir overhead.
- Retry com backoff em rate limit (429).

### `src/rag/storage.ts`
Postgres queries:
- `upsertChunk(chunk)` — insert ou update por `id` (hash de `source_id + chunk_index`)
- `deleteChunksBySource(source_type, source_id)` — pra limpar antes de re-chunkar uma page modificada
- `searchHybrid(query_embedding, query_text, filters, top_k)` — query principal

### `src/rag/search.ts`
Hybrid search:
1. Embeda a query com Voyage
2. Em paralelo:
   - Vector search: `ORDER BY embedding <=> $1 LIMIT top_k * 3`
   - Full-text search: `ORDER BY ts_rank(tsv, query) DESC LIMIT top_k * 3` (config português)
3. Reciprocal Rank Fusion: pra cada chunk, `score = sum(1/(60 + rank_i))` em cada lista; ordena por score combinado
4. Aplica filtros via WHERE
5. Retorna `top_k` com chunks vizinhos (chunks com mesmo `source_id` e `chunk_index ± 1`) pra dar contexto

### `src/tools.ts`
Adiciona `registerBrainSearchTool(server)` que registra:
```typescript
{
  name: "brain_search",
  description: "Search Bruno's second brain (Notion, Granola, Calendar) using hybrid semantic + keyword retrieval. Returns chunks with metadata and source URLs.",
  inputSchema: {
    query: z.string(),
    top_k: z.number().int().min(1).max(50).default(12),
    mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
    filters: z.object({
      workspace: z.enum(["personal", "globalcripto", "nora"]).optional(),
      db: z.string().optional(),
      frente: z.string().optional(),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      pessoa: z.string().optional()
    }).optional()
  }
}
```

## Schema Postgres

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE brain_chunks (
  id              text PRIMARY KEY,
  source_type     text NOT NULL,           -- 'notion' | 'granola' | 'calendar'
  source_id       text NOT NULL,
  workspace       text,                    -- 'personal' | 'globalcripto' | 'nora' | null
  db_name         text,                    -- 'Reunioes' | 'Insights' | ... | null
  parent_url      text,
  chunk_index     int NOT NULL,
  text            text NOT NULL,
  embedding       vector(1024),
  tsv             tsvector
                    GENERATED ALWAYS AS (to_tsvector('portuguese', text)) STORED,
  metadata        jsonb,
  indexed_at      timestamptz DEFAULT now(),
  source_updated  timestamptz
);

CREATE INDEX brain_chunks_embedding_idx
  ON brain_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX brain_chunks_tsv_idx
  ON brain_chunks USING GIN (tsv);
CREATE INDEX brain_chunks_source_idx
  ON brain_chunks (source_type, source_id);
CREATE INDEX brain_chunks_workspace_idx
  ON brain_chunks (workspace, db_name);
CREATE INDEX brain_chunks_metadata_idx
  ON brain_chunks USING GIN (metadata);

CREATE TABLE sync_state (
  source_type text PRIMARY KEY,
  last_sync_at timestamptz NOT NULL DEFAULT '1970-01-01'
);

CREATE TABLE embedding_cache (
  text_hash text PRIMARY KEY,
  embedding vector(1024) NOT NULL,
  created_at timestamptz DEFAULT now()
);
```

## Estimativas de custo e tamanho

Estimativa do corpus inicial:
- Notion: 3 workspaces, ~500 páginas/DB rows totais, média ~1000 chars cada → ~5M tokens
- Granola: ~200 summaries históricas × ~500 tokens → ~100k tokens
- Calendar: ~1000 eventos × ~50 tokens → ~50k tokens
- **Total inicial:** ~5.2M tokens → ~10k chunks (~500 tokens cada)

Custos:
- **Indexação inicial Voyage:** ~5.2M × $0.18/M = **~US$ 0.94**
- **Indexação incremental** (delta diário ~50 chunks): negligível
- **Storage Postgres:** ~10k chunks × (2KB texto + 4KB embedding + 1KB metadata) ≈ **70 MB** (cabe trivial)
- **CPU pra reindex full:** ~30min na VPS (limit é throughput Voyage API)

## Variáveis de ambiente

`.env` adições:
```
VOYAGE_API_KEY=<voyage api key>
POSTGRES_URL=postgresql://brain:<pwd>@localhost:5432/brain
EMBEDDING_MODEL=voyage-3-large
EMBEDDING_DIM=1024
INDEXER_CRON=0 * * * *           # toda hora
```

## Operação

- **Setup inicial:** `apt install postgresql-16 postgresql-16-pgvector`, criar DB + role, rodar `scripts/init-db.sql`, rodar `scripts/reindex-all.mjs` (one-time).
- **PM2:** `pm2 start ecosystem.config.cjs` adiciona `brain-indexer` ao lado de `notion-mcp`.
- **Backup:** cron diário `pg_dump brain > /var/backups/brain-$(date +%F).dump`, retenção 7 dias.
- **Logs:** `pm2 logs brain-indexer` mostra cada ciclo de sync com `inserted/updated/skipped/errored` counts.

## Testing

- **Unit:** chunker, hybrid RRF rank fusion, filter SQL builder.
- **Smoke:** indexa 10 reuniões conhecidas, query "Talos" deve retornar chunks da reunião com Granola id `7b15a5af-...` no top-3.
- **E2E:** roda full reindex + 10 queries fixtures cobrindo 3 use-cases (lookup, síntese, conexão); verifica recall por hand-labeled relevance.
- **Filter test:** query genérica + `filters.workspace=personal`; nenhum chunk de globalcripto/nora deve aparecer.

## Roadmap em fases

1. **Fase 1 — Núcleo (~1 dia):** Postgres + schema + indexer + chunker + embeddings + tool MCP. Indexar apenas workspace `personal` (Cérebro) pra validar end-to-end.
2. **Fase 2 — Cobertura completa (~meio dia):** adiciona workspaces `globalcripto` e `nora`, Granola summaries, Calendar.
3. **Fase 3 — Refino (~meio dia):** hybrid RRF tuning, filtros completos, observability (counters de queries, cache hit rate).

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Voyage API down/rate-limited | Indexer com retry+backoff; queries usam cache (não bloqueia) |
| Voyage qualidade ruim em PT-BR | Plano B: Cohere v4 (1 var + reindex, ~10min, ~$1.20) |
| Postgres explode em disco | Corpus estimado 70 MB; alarm em 5 GB; vacuum semanal |
| Notion API rate limit no full reindex | Paralelizar com semáforo (max 3 reqs concorrentes); 1ª indexação aceita ~30min |
| pgvector ivfflat recall ruim | Tunar `lists` parameter; alternativa HNSW índice se ivfflat decepcionar |

## Decisões em aberto pra Fase 2/3

- Politica de retenção: indefinida (manter tudo). Reavaliar quando passar de 100k chunks.
- Re-ranking pós-retrieval com Voyage `rerank-2`: não no MVP, considerar se síntese tiver qualidade ruim.
- Auto-prune de chunks órfãos (page deletada no Notion): cron semanal compara `source_id` no Postgres com lista atual; deleta órfãos.

## Próximos passos

1. User revisa este spec.
2. Após aprovação, invocar skill `writing-plans` pra criar plano de implementação detalhado da **Fase 1**.
3. Implementação faseada (Fase 1 → smoke test com user → Fase 2 → Fase 3).
