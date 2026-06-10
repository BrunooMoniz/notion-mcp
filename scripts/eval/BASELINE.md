# F8 Retrieval Eval — Baseline

## Run

- **Date:** 2026-06-10
- **Commit:** 317bd78d50384acb55ed67b1c25f7fb2c5ba1c2f
- **Golden set:** `scripts/eval/golden-set.jsonl` (24 questions, PT-BR, derived from real VPS titles)
- **Account:** `bruno`
- **Config:**
  - `UTILITY_ALPHA`: 0.15 (default)
  - `RERANK_ENABLED`: not set (default on)
  - `BRAIN_MAX_PER_URL`: not set (default 3)
  - `GRANOLA_INDEX_TRANSCRIPT`: not set (default off — only summary indexed)

## Results

| metric     | value |
|------------|-------|
| Recall@5   | 0.875 |
| MRR        | 0.604 |
| n          | 24    |

## Failing questions

| question | recall@5 | mrr | reason |
|----------|----------|-----|--------|
| Reunião Kick-off Nora Finance <> Pinheiro Neto | 0 | 0.143 | Granola note `73eb4eae` ranked 7th; competing Notion meeting note wins top-5 |
| Nora <> Woovi próximos passos | 0 | 0.125 | Granola `512dc17d` ranked 8th; other Nora/Woovi-adjacent notes dilute pool |
| Alinhamento Nora PNA (question 22) | 0 | 0 | Wrong expect URL in golden set (entry was misconfigured) |

## Notes on existing architecture

- **Dedup by source_id before rerank:** Not present. RRF pool can contain multiple chunks from the same source_id, all competing for top-N slots before diversifyHits by URL. Improvement 3a will add dedup-by-source_id at pool level.
- **Granola chunking:** Context header already includes title+date on every chunk. Granola chunks are section-sized (~200-500 tokens). No chunking issues found.
- **Recency boost:** Not present. Added as optional env RECENCY_BOOST (default off).
