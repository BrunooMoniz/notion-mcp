// src/rag/rerank.ts
// Overridable p/ rotear por um egress IPv6 (mesmo racional de VOYAGE_EMBEDDINGS_URL).
const RERANK_URL = process.env.VOYAGE_RERANK_URL ?? "https://api.voyageai.com/v1/rerank";
const DEFAULT_MODEL = "rerank-2.5-lite";

export interface RerankDoc {
  id: string;
  text: string;
}
export interface RerankResult {
  id: string;
  relevance_score: number | null;
}

/**
 * Precedence (applied review fix):
 *   RERANK_ENABLED=false  -> hard OFF (kill switch), ignores opt.
 *   RERANK_ENABLED unset/true -> per-call opt governs (default true).
 * The opt can never force rerank ON when the env kill-switch is off.
 */
export function rerankEnabled(opt: boolean | undefined): boolean {
  if (process.env.RERANK_ENABLED === "false") return false;
  return opt ?? true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function rerankDocuments(
  query: string,
  docs: RerankDoc[],
  topN: number,
  instructionPtBr?: string,
  opts: { retries?: number } = {},
): Promise<RerankResult[]> {
  const retries = opts.retries ?? 3;
  const model = process.env.RERANK_MODEL ?? DEFAULT_MODEL;
  const apiKey = process.env.VOYAGE_API_KEY;

  const fallback = (): RerankResult[] =>
    docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: null }));

  if (!apiKey || docs.length === 0) return fallback();

  const body = {
    model,
    query: instructionPtBr ? `${instructionPtBr}\n\n${query}` : query,
    documents: docs.map((d) => d.text),
    top_k: topN,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RERANK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleep(2 ** attempt * 250);
          continue;
        }
        return fallback();
      }
      if (!res.ok) return fallback();

      const json = (await res.json()) as {
        data: { index: number; relevance_score: number }[];
      };
      // Map by Voyage's `index` (position in submitted documents), preserving
      // Voyage's returned order (already sorted by relevance desc).
      return json.data.map((r) => ({
        id: docs[r.index].id,
        relevance_score: r.relevance_score,
      }));
    } catch {
      if (attempt < retries) {
        await sleep(2 ** attempt * 250);
        continue;
      }
      return fallback();
    }
  }
  return fallback();
}
