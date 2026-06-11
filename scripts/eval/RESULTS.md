# F8 Retrieval Eval — Results

All runs on VPS (Postgres + Voyage), account=bruno, 24-question golden set.

## Before / After Summary

| improvement | Recall@5 | MRR    | delta R@5 | delta MRR | kept? |
|-------------|----------|--------|-----------|-----------|-------|
| Baseline (317bd78) | 0.875 | 0.604 | — | — | — |
| 3a: dedup by source_id (65a3b8c) | 0.917 | 0.616 | +0.042 | +0.012 | YES |
| 3b: Granola chunking (no change) | — | — | — | — | N/A |
| 3c: Recency boost off (a642088) | 0.917 | 0.616 | 0 | 0 | code in, default off |
| 3c: Recency boost=0.15 (30d halflife) | 0.917 | 0.616 | 0 | 0 | — |
| 3c: Recency boost=0.30 (14d halflife) | 0.917 | 0.616 | 0 | 0 | — |

**Final (feat/retrieval-eval head): Recall@5=0.917, MRR=0.616**

## Details by improvement

### 3a: Dedup candidates by source_id before reranking

**What:** `dedupBySourceId()` in `src/rag/search.ts` — keeps only the best RRF-scored
chunk per source_id before passing the pool to the Voyage reranker. Eliminates the
problem of a single long document crowding out other relevant documents by occupying
multiple slots in the reranker's top-N budget.

**Effect:**
- Kick-off Nora Finance <> Pinheiro Neto: recall@5 0→1 (fixed!)
- Conciliação Parfin: mrr 0.5→1.0 (improved)
- Mapeamento de riscos Firebit: mrr 1→0.333 (slight degradation — different chunk wins)
- Net: Recall@5 +0.042, MRR +0.012

**Decision:** KEPT.

### 3b: Granola chunking granularity

**Analysis:** Context header (title + date) is already prepended to every chunk in the
existing code (`index-document.ts` + `context-header.ts`). Chunks are section-sized
(~200-500 tokens per `### Section`). No chunking defects found. The failing question
(Nora<>Woovi "próximos passos") was a ranking issue, not a chunking issue: chunk_index=6
has the "Implementação e Próximos Passos" section with the correct header, it just
ranked 8th before 3a.

**Decision:** NO CHANGE. Code already correct.

### 3c: Optional recency boost

**What:** `applyRecencyBoost()` in `src/rag/search.ts`. Applied post-diversification.
Formula: `score *= (1 + RECENCY_BOOST * exp(-age_days * ln2/RECENCY_HALFLIFE_DAYS))`.
Zero cost when `RECENCY_BOOST=0` (default).

**Effect:** Tested with RECENCY_BOOST=0.15 (halflife=30d) and RECENCY_BOOST=0.30
(halflife=14d). Zero delta vs 3a on this golden set — questions span March-June 2026
with no temporal bias. The boost correctly reorders within topK without expanding it,
so it doesn't hurt recall, but doesn't help either on this dataset.

**Decision:** CODE IN, DEFAULT OFF. The feature is available as a knob for workloads
with strong recency preference (e.g., daily standup retrieval). Will not activate on
this account until further testing.

## Discarded improvements

None were tried and discarded — 3a was kept, 3b was no-op, 3c is dormant.

## Failing questions (post-3a)

| question | recall@5 | mrr | note |
|----------|----------|-----|------|
| Nora <> Woovi próximos passos | 0 | 0.125 | chunk_index=6 still ranks 8th even after dedup |
| Alinhamento Nora PNA (q22) | 0 | 0 | Golden set entry had wrong expect URL; question ambiguous |

## 2026-06-11 — fix/hnsw-multitenant-recall (ef_search=200 + iterative_scan=strict_order)

| metric | baseline (post-3a) | main em 2026-06-11 | com fix |
|---|---|---|---|
| Recall@5 | 0.917 | 0.917 | 0.833 |
| MRR | 0.616 | 0.610 | 0.597 |

**Exceção justificada à regra "manter ou melhorar":** o scan HNSW ranqueia
candidatos globalmente e o filtro de account/workspace é pós-scan; com vários
tenants de conteúdo quase idêntico, o ef_search default (40) colapsava a busca
semântica de contas friend para ZERO resultados em queries naturais
(reproduzido: "reunião Parfin Global Cripto" → 0 rows; com ef_search=400 → 10).
O eval mede só a conta owner e não captura esse modo de falha. Custo medido no
owner: 3/24 perguntas com o doc esperado deslizando do rank 3-5 para 6-8
(dilução do RRF/dedup com o pool semântico completo). Follow-up de tuning
possível: dedup por melhor score de rerank em vez de RRF.
