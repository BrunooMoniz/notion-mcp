// scripts/eval/run-eval.mts
import "dotenv/config"; // load .env so brainSearch has VOYAGE_API_KEY / POSTGRES_URL
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- pure metric helpers (unit-tested, no IO) -------------------------------

export function recallAtK(results: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const topK = new Set(results.slice(0, k));
  const found = expected.filter((id) => topK.has(id)).length;
  return found / expected.length;
}

export function mrr(results: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  for (let i = 0; i < results.length; i++) {
    if (expectedSet.has(results[i])) return 1 / (i + 1);
  }
  return 0;
}

// Substring variants used by the runner: the golden set specifies `expect` as
// stable substrings (the page-id hex), matched against each hit's parent_url so
// the gabarito survives page renames and URL-format changes.
export function recallAtKSub(urls: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const topK = urls.slice(0, k);
  const found = expected.filter((e) => e.length > 0 && topK.some((u) => u.includes(e))).length;
  return found / expected.length;
}

export function mrrSub(urls: string[], expected: string[]): number {
  for (let i = 0; i < urls.length; i++) {
    if (expected.some((e) => e.length > 0 && urls[i].includes(e))) return 1 / (i + 1);
  }
  return 0;
}

export interface EvalRow {
  recall_at_5: number;
  mrr: number;
}

export function aggregate(rows: EvalRow[]): { recall_at_5: number; mrr: number } {
  if (rows.length === 0) return { recall_at_5: 0, mrr: 0 };
  const sum = rows.reduce(
    (acc, r) => ({ recall_at_5: acc.recall_at_5 + r.recall_at_5, mrr: acc.mrr + r.mrr }),
    { recall_at_5: 0, mrr: 0 },
  );
  return {
    recall_at_5: sum.recall_at_5 / rows.length,
    mrr: sum.mrr / rows.length,
  };
}

// --- golden set IO ----------------------------------------------------------

interface GoldenItem {
  q: string;
  // Substrings to find in a returned hit's parent_url (use the stable page-id
  // hex so the gabarito survives renames). The question is "hit" if any expected
  // substring appears in a top-k result's parent_url.
  expect: string[];
  type: "lookup" | "sintese" | "estado";
  note?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadGoldenSet(path: string): GoldenItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GoldenItem);
}

// --- runner -----------------------------------------------------------------

async function main(): Promise<void> {
  // Lazy import so the unit test (which only touches the pure helpers above)
  // never opens a DB pool. brainSearch path is confirmed in F.1.
  const { brainSearch } = await import("../../src/rag/search.js");

  const goldenPath = resolve(__dirname, "golden-set.jsonl");
  const items = loadGoldenSet(goldenPath);

  const rows: (EvalRow & { q: string; type: string })[] = [];
  for (const item of items) {
    // brainSearch runs OUTSIDE an HTTP request (no AsyncLocalStorage store),
    // so getAllowedWorkspaces() returns null (no workspace filter) — see F.4.
    const hits = await brainSearch(item.q, { topK: 10 });
    const urls = hits.map((h) => h.chunk.parent_url ?? "");
    rows.push({
      q: item.q,
      type: item.type,
      recall_at_5: recallAtKSub(urls, item.expect, 5),
      mrr: mrrSub(urls, item.expect),
    });
  }

  const agg = aggregate(rows);
  const out = {
    timestamp: new Date().toISOString(),
    n: items.length,
    aggregate: agg,
    per_question: rows,
  };

  const resultsDir = resolve(__dirname, "../../eval-results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const stamp = out.timestamp.replace(/[:.]/g, "-");
  const outPath = resolve(resultsDir, `${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  // markdown diff vs frozen baseline
  const baselinePath = resolve(resultsDir, "baseline-f0.json");
  let diff = "";
  if (existsSync(baselinePath)) {
    const base = JSON.parse(readFileSync(baselinePath, "utf8"));
    const dR = (agg.recall_at_5 - base.aggregate.recall_at_5).toFixed(3);
    const dM = (agg.mrr - base.aggregate.mrr).toFixed(3);
    diff =
      `\n| metric | baseline | now | delta |\n|---|---|---|---|\n` +
      `| Recall@5 | ${base.aggregate.recall_at_5.toFixed(3)} | ${agg.recall_at_5.toFixed(3)} | ${dR} |\n` +
      `| MRR | ${base.aggregate.mrr.toFixed(3)} | ${agg.mrr.toFixed(3)} | ${dM} |\n`;
  }

  console.log(`# Eval (${out.timestamp}) — n=${out.n}`);
  console.log(`Recall@5: ${agg.recall_at_5.toFixed(3)}  MRR: ${agg.mrr.toFixed(3)}`);
  console.log(`Wrote ${outPath}`);
  if (diff) console.log(diff);
}

// Only run main() when executed directly, never on import (keeps tests pure).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
