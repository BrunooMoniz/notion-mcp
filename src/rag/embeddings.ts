// src/rag/embeddings.ts
import { createHash } from "node:crypto";
import pg from "pg";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = process.env.EMBEDDING_MODEL ?? "voyage-3-large";
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

async function callVoyage(inputs: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: inputs,
      model: MODEL,
      input_type: "document",
      output_dimension: DIM,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as VoyageResponse;
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

let pgPool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  }
  return pgPool;
}

interface BatchEmbedOptions {
  useCache?: boolean;
  inputType?: "document" | "query";
}

const BATCH_SIZE = 128;

export async function batchEmbed(
  texts: string[],
  opts: BatchEmbedOptions = {},
): Promise<number[][]> {
  const useCache = opts.useCache !== false;
  const results: (number[] | null)[] = texts.map(() => null);
  const toFetch: { idx: number; text: string; hash: string }[] = [];

  if (useCache && texts.length > 0) {
    const hashes = texts.map(hashText);
    const pool = getPool();
    const { rows } = await pool.query<{ text_hash: string; embedding: string }>(
      `SELECT text_hash, embedding::text AS embedding FROM embedding_cache WHERE text_hash = ANY($1)`,
      [hashes],
    );
    const cacheMap = new Map(rows.map((r) => [r.text_hash, parseVector(r.embedding)]));
    texts.forEach((t, i) => {
      const cached = cacheMap.get(hashes[i]);
      if (cached) {
        results[i] = cached;
      } else {
        toFetch.push({ idx: i, text: t, hash: hashes[i] });
      }
    });
  } else {
    texts.forEach((t, i) => toFetch.push({ idx: i, text: t, hash: hashText(t) }));
  }

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_SIZE);
    const vectors = await callVoyage(chunk.map((c) => c.text));
    chunk.forEach((c, j) => {
      results[c.idx] = vectors[j];
    });

    if (useCache) {
      const pool = getPool();
      const values = chunk.map((c, j) => `('${c.hash}', '${formatVector(vectors[j])}')`).join(",");
      await pool.query(
        `INSERT INTO embedding_cache (text_hash, embedding) VALUES ${values} ON CONFLICT DO NOTHING`,
      );
    }
  }

  return results.map((r) => {
    if (!r) throw new Error("embedding missing — internal bug");
    return r;
  });
}

export async function embedQuery(text: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: [text],
      model: MODEL,
      input_type: "query",
      output_dimension: DIM,
    }),
  });
  if (!res.ok) throw new Error(`Voyage query API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as VoyageResponse;
  return json.data[0].embedding;
}

export function formatVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export function parseVector(s: string): number[] {
  return s.replace(/^\[|\]$/g, "").split(",").map(Number);
}
