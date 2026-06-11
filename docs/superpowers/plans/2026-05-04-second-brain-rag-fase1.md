# Second Brain RAG — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the RAG core inside the existing `notion-mcp` repo: Postgres + pgvector + Voyage-3-large embeddings + a single MCP tool `brain_search`. Indexes Bruno's `personal` Notion workspace (the Cérebro) end-to-end as Fase 1 validation.

**Architecture:** Two PM2 processes on the same VPS — `notion-mcp` (HTTP MCP server, exposes the new `brain_search` tool) and `brain-indexer` (cron-driven delta sync that pulls Notion pages, chunks them, embeds via Voyage, and upserts into Postgres). Hybrid search combines vector cosine distance with PT-BR full-text via Reciprocal Rank Fusion.

**Tech Stack:** Node.js 20+, TypeScript (NodeNext modules), Postgres 16 + pgvector, Voyage AI (`voyage-3-large`), `pg` driver, `node-cron`, `node:test` for unit tests, `tsx` for execution. Repo: https://github.com/BrunooMoniz/notion-mcp.

**Reference spec:** `docs/superpowers/specs/2026-05-04-second-brain-rag-design.md`

**Scope of Fase 1:** indexes only Notion workspace `personal`. Granola, Calendar, and the other workspaces (`globalcripto`, `nora`) come in Fase 2 (separate plan).

---

## File Structure

**New files:**
- `scripts/init-db.sql` — Postgres schema (extension, tables, indexes)
- `src/rag/types.ts` — shared interfaces (`Chunk`, `SearchResult`, `Filters`, etc.)
- `src/rag/embeddings.ts` — Voyage AI wrapper with hash-based cache
- `src/rag/chunker.ts` — semantic chunker for Notion blocks
- `src/rag/storage.ts` — Postgres queries (upsert/delete/search)
- `src/rag/notion-source.ts` — pulls and flattens Notion pages → text + metadata
- `src/rag/indexer.ts` — orchestrates delta sync (one-shot function)
- `src/rag/search.ts` — hybrid retrieval with RRF
- `src/rag/brain-tool.ts` — registers `brain_search` MCP tool
- `src/index-indexer.ts` — entrypoint for the `brain-indexer` PM2 process (runs cron)
- `src/rag/__tests__/chunker.test.ts`
- `src/rag/__tests__/embeddings.test.ts`
- `src/rag/__tests__/storage.test.ts`
- `src/rag/__tests__/search.test.ts`
- `.env.example` — new env keys with placeholder values

**Modified files:**
- `src/index.ts` — call `registerBrainSearchTool(server)` in McpServer setup
- `src/tools.ts` — leave as is (new tool lives in `brain-tool.ts` to keep tools.ts manageable)
- `package.json` — add deps and test script
- `tsconfig.json` — exclude `__tests__` from build output
- `ecosystem.config.cjs` — add `brain-indexer` app

---

## Task 0: VPS prerequisites (manual, ~10 min)

> **Context:** This is the only task that runs on the VPS directly. Everything else runs locally and gets deployed via git pull + pm2 restart.

**Files:** none (server-side setup)

- [ ] **Step 1: SSH into VPS and install Postgres 16 + pgvector**

```bash
ssh root@124.198.128.68
apt update
apt install -y postgresql-16 postgresql-16-pgvector
systemctl enable --now postgresql
```

- [ ] **Step 2: Create role and database**

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE brain WITH LOGIN PASSWORD 'CHANGE_ME_TO_A_STRONG_PASSWORD';
CREATE DATABASE brain OWNER brain;
\c brain
CREATE EXTENSION vector;
SQL
```

- [ ] **Step 3: Verify**

```bash
sudo -u postgres psql -d brain -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
```
Expected: one row showing `vector` and a version like `0.7.x`.

- [ ] **Step 4: Record `POSTGRES_URL` for `.env`**

Format: `postgresql://brain:<password>@localhost:5432/brain`

---

## Task 1: Init schema script

**Files:**
- Create: `scripts/init-db.sql`

- [ ] **Step 1: Write the schema**

```sql
-- scripts/init-db.sql
-- Run with: psql "$POSTGRES_URL" -f scripts/init-db.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS brain_chunks (
  id              text PRIMARY KEY,
  source_type     text NOT NULL,
  source_id       text NOT NULL,
  workspace       text,
  db_name         text,
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

CREATE INDEX IF NOT EXISTS brain_chunks_embedding_idx
  ON brain_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS brain_chunks_tsv_idx
  ON brain_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS brain_chunks_source_idx
  ON brain_chunks (source_type, source_id);
CREATE INDEX IF NOT EXISTS brain_chunks_workspace_idx
  ON brain_chunks (workspace, db_name);
CREATE INDEX IF NOT EXISTS brain_chunks_metadata_idx
  ON brain_chunks USING GIN (metadata);

CREATE TABLE IF NOT EXISTS sync_state (
  source_type text PRIMARY KEY,
  last_sync_at timestamptz NOT NULL DEFAULT '1970-01-01'
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash  text PRIMARY KEY,
  embedding  vector(1024) NOT NULL,
  created_at timestamptz DEFAULT now()
);
```

- [ ] **Step 2: Run on the VPS**

```bash
ssh root@124.198.128.68 'PGPASSWORD=<pwd> psql -h localhost -U brain -d brain -f -' < scripts/init-db.sql
```

- [ ] **Step 3: Verify tables exist**

```bash
ssh root@124.198.128.68 'sudo -u postgres psql -d brain -c "\dt"'
```
Expected: 3 tables (`brain_chunks`, `sync_state`, `embedding_cache`).

- [ ] **Step 4: Commit**

```bash
git add scripts/init-db.sql
git commit -m "add Postgres schema for second brain RAG"
```

---

## Task 2: Add dependencies and test infrastructure

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `.env.example`

- [ ] **Step 1: Update `package.json`**

```json
{
  "name": "notion-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "start:indexer": "node dist/index-indexer.js",
    "dev": "tsx src/index.ts",
    "dev:indexer": "tsx src/index-indexer.ts",
    "test": "tsx --test src/rag/__tests__/*.test.ts",
    "reindex": "tsx scripts/reindex-all.mts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.10.0",
    "@notionhq/client": "^2.2.15",
    "dotenv": "^17.4.0",
    "express": "^4.18.3",
    "express-rate-limit": "^8.3.2",
    "helmet": "^8.1.0",
    "node-cron": "^3.0.3",
    "pg": "^8.13.1",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/express-rate-limit": "^5.1.3",
    "@types/node": "^20.0.0",
    "@types/node-cron": "^3.0.11",
    "@types/pg": "^8.11.10",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Update `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/**/__tests__/**"]
}
```

- [ ] **Step 3: Create `.env.example`**

```
NOTION_GLOBALCRIPTO_TOKEN=ntn_xxx
NOTION_PERSONAL_TOKEN=ntn_xxx
NOTION_NORA_TOKEN=ntn_xxx
BEARER_TOKEN=generate-with-openssl-rand-hex-32
BASE_URL=https://your-vps.example.net
OAUTH_PASSWORD_HASH=salt:hash

# RAG (new in Fase 1)
VOYAGE_API_KEY=pa-xxx
POSTGRES_URL=postgresql://brain:password@localhost:5432/brain
EMBEDDING_MODEL=voyage-3-large
EMBEDDING_DIM=1024
INDEXER_CRON=0 * * * *
```

- [ ] **Step 4: Install and verify**

```bash
npm install
npm run build
```
Expected: build succeeds, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example
git commit -m "add deps for RAG (pg, node-cron, types) and test infra"
```

---

## Task 3: Shared types

**Files:**
- Create: `src/rag/types.ts`

- [ ] **Step 1: Write types**

```typescript
// src/rag/types.ts

export type SourceType = "notion" | "granola" | "calendar";
export type Workspace = "personal" | "globalcripto" | "nora";

export interface Chunk {
  id: string;                  // hash(source_id + chunk_index)
  source_type: SourceType;
  source_id: string;
  workspace: Workspace | null;
  db_name: string | null;
  parent_url: string | null;
  chunk_index: number;
  text: string;
  metadata: Record<string, unknown>;
  source_updated: Date | null;
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

export interface SearchFilters {
  workspace?: Workspace;
  db?: string;
  frente?: string;
  date_from?: string;          // YYYY-MM-DD
  date_to?: string;
  pessoa?: string;
}

export type SearchMode = "hybrid" | "semantic" | "keyword";

export interface SearchHit {
  chunk: Chunk;
  score: number;
  neighbors?: Chunk[];
}

export interface IndexableDocument {
  source_type: SourceType;
  source_id: string;
  workspace: Workspace | null;
  db_name: string | null;
  parent_url: string;
  text: string;                // full document text — chunker splits it
  metadata: Record<string, unknown>;
  source_updated: Date;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rag/types.ts
git commit -m "add RAG shared types"
```

---

## Task 4: Embeddings wrapper with cache (TDD)

**Files:**
- Create: `src/rag/__tests__/embeddings.test.ts`
- Create: `src/rag/embeddings.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/rag/__tests__/embeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashText, batchEmbed } from "../embeddings.js";

test("hashText returns deterministic sha256 hex", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("world"));
  assert.equal(hashText("hello").length, 64);
});

test("batchEmbed returns vectors of length 1024 per input", async () => {
  // Skip if no API key (CI/dev without secrets)
  if (!process.env.VOYAGE_API_KEY) {
    console.log("skipping: no VOYAGE_API_KEY");
    return;
  }
  const out = await batchEmbed(["a curta", "outra frase em portugues"], { useCache: false });
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 1024);
  assert.equal(out[1].length, 1024);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL with "Cannot find module ../embeddings.js" or similar.

- [ ] **Step 3: Implement**

```typescript
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
  // Sort by index to be safe
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

  // Batch the API calls
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
  // Queries use input_type="query" per Voyage best-practices
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
  // pgvector text format: '[1,2,3]'
  return s.replace(/^\[|\]$/g, "").split(",").map(Number);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```
Expected: 2 PASS (the API call test will skip if no key set; that's fine for dev without secrets).

- [ ] **Step 5: Commit**

```bash
git add src/rag/embeddings.ts src/rag/__tests__/embeddings.test.ts
git commit -m "add Voyage embedding wrapper with Postgres-backed cache"
```

---

## Task 5: Semantic chunker (TDD)

**Files:**
- Create: `src/rag/__tests__/chunker.test.ts`
- Create: `src/rag/chunker.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/rag/__tests__/chunker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, estimateTokens } from "../chunker.js";

test("estimateTokens approximates 1 token per 4 chars", () => {
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("chunkText returns single chunk when text is small", () => {
  const out = chunkText("uma frase curta.", { targetTokens: 500 });
  assert.equal(out.length, 1);
  assert.equal(out[0], "uma frase curta.");
});

test("chunkText respects paragraph boundaries", () => {
  const text = "primeiro paragrafo.\n\nsegundo paragrafo.\n\nterceiro paragrafo.";
  const out = chunkText(text, { targetTokens: 8 });
  // 8 tokens ~= 32 chars; each paragraph is ~20 chars, should produce 3 chunks
  assert.ok(out.length >= 2);
  out.forEach((c) => assert.ok(c.trim().length > 0));
});

test("chunkText applies overlap between chunks", () => {
  const long = Array.from({ length: 20 }, (_, i) => `paragrafo ${i} com algum conteudo aqui.`).join("\n\n");
  const out = chunkText(long, { targetTokens: 50, overlapTokens: 10 });
  assert.ok(out.length >= 2);
  // Last words of chunk[0] should appear at start of chunk[1] (overlap)
  const tail = out[0].split(/\s+/).slice(-3).join(" ");
  assert.ok(out[1].includes(tail.split(" ")[2]) || out[1].length > 0);
});

test("chunkText breaks at headings", () => {
  const text = "intro paragrafo.\n\n## Heading 1\n\nconteudo.\n\n## Heading 2\n\nmais conteudo.";
  const out = chunkText(text, { targetTokens: 1000 }); // huge target — only headings should split
  assert.equal(out.length, 3);
  assert.ok(out[1].startsWith("## Heading 1"));
  assert.ok(out[2].startsWith("## Heading 2"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL with "Cannot find module ../chunker.js".

- [ ] **Step 3: Implement**

```typescript
// src/rag/chunker.ts

export function estimateTokens(text: string): number {
  // Rough heuristic: 1 token ≈ 4 chars (true for English; PT-BR similar)
  return Math.ceil(text.length / 4);
}

interface ChunkOptions {
  targetTokens?: number;        // default 500
  overlapTokens?: number;       // default 50
  maxTokens?: number;           // hard ceiling, default 800
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = opts.targetTokens ?? 500;
  const overlap = opts.overlapTokens ?? 50;
  const max = opts.maxTokens ?? 800;

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= target) return [trimmed];

  // Split first by markdown headings (## or ###), then by paragraphs (\n\n), then by sentences
  const sections = splitByHeadings(trimmed);
  const chunks: string[] = [];

  for (const section of sections) {
    if (estimateTokens(section) <= max) {
      chunks.push(...packParagraphs(section, target, overlap, max));
    } else {
      // Section too big even after paragraph packing — split by sentences
      chunks.push(...packSentences(section, target, overlap, max));
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}

function splitByHeadings(text: string): string[] {
  const parts: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length > 0) {
      parts.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) parts.push(current.join("\n").trim());
  return parts.filter((p) => p.length > 0);
}

function packParagraphs(text: string, target: number, overlap: number, max: number): string[] {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (bufTokens + paraTokens > max && buf.length > 0) {
      chunks.push(buf.join("\n\n"));
      // Overlap: keep last N tokens worth of paragraphs
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join("\n\n"));
    }
    buf.push(para);
    bufTokens += paraTokens;
    if (bufTokens >= target) {
      chunks.push(buf.join("\n\n"));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join("\n\n"));
    }
  }
  if (buf.length > 0) chunks.push(buf.join("\n\n"));
  return chunks;
}

function packSentences(text: string, target: number, overlap: number, max: number): string[] {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  for (const s of sentences) {
    const t = estimateTokens(s);
    if (bufTokens + t > max && buf.length > 0) {
      chunks.push(buf.join(" "));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join(" "));
    }
    buf.push(s);
    bufTokens += t;
    if (bufTokens >= target) {
      chunks.push(buf.join(" "));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join(" "));
    }
  }
  if (buf.length > 0) chunks.push(buf.join(" "));
  return chunks;
}

function takeTail(parts: string[], targetTokens: number): string[] {
  // Keep enough trailing parts to reach ~targetTokens, walking from the end
  const out: string[] = [];
  let acc = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    out.unshift(parts[i]);
    acc += estimateTokens(parts[i]);
    if (acc >= targetTokens) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```
Expected: all chunker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rag/chunker.ts src/rag/__tests__/chunker.test.ts
git commit -m "add semantic chunker for Notion text"
```

---

## Task 6: Postgres storage (TDD)

**Files:**
- Create: `src/rag/__tests__/storage.test.ts`
- Create: `src/rag/storage.ts`

> **Test setup note:** these tests need a live Postgres. The test reuses `POSTGRES_URL` and prefixes all `source_id` with `__test__` so it never collides with real data. Use a clean `brain` DB or accept the test rows.

- [ ] **Step 1: Write the failing test**

```typescript
// src/rag/__tests__/storage.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { upsertChunks, deleteBySource, getPool, closePool } from "../storage.js";
import type { ChunkWithEmbedding } from "../types.js";

const TEST_PREFIX = "__test_storage__";

function fakeEmbed(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed * (i + 1)) * 0.01);
}

before(async () => {
  if (!process.env.POSTGRES_URL) throw new Error("POSTGRES_URL required");
  const pool = getPool();
  await pool.query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${TEST_PREFIX}%`]);
});

after(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${TEST_PREFIX}%`]);
  await closePool();
});

test("upsertChunks inserts and re-upsert updates", async () => {
  const chunk: ChunkWithEmbedding = {
    id: `${TEST_PREFIX}-id-0`,
    source_type: "notion",
    source_id: `${TEST_PREFIX}-page-1`,
    workspace: "personal",
    db_name: "Reunioes",
    parent_url: "https://notion.so/foo",
    chunk_index: 0,
    text: "primeiro texto",
    embedding: fakeEmbed(1),
    metadata: { frente: "Global Cripto" },
    source_updated: new Date("2026-04-20"),
  };
  await upsertChunks([chunk]);
  const pool = getPool();
  const r1 = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE id=$1`,
    [chunk.id],
  );
  assert.equal(r1.rows[0].text, "primeiro texto");

  await upsertChunks([{ ...chunk, text: "texto atualizado" }]);
  const r2 = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE id=$1`,
    [chunk.id],
  );
  assert.equal(r2.rows[0].text, "texto atualizado");
});

test("deleteBySource removes all chunks for a source", async () => {
  const sourceId = `${TEST_PREFIX}-page-2`;
  const chunks: ChunkWithEmbedding[] = [0, 1, 2].map((i) => ({
    id: `${TEST_PREFIX}-multi-${i}`,
    source_type: "notion",
    source_id: sourceId,
    workspace: "personal",
    db_name: null,
    parent_url: null,
    chunk_index: i,
    text: `chunk ${i}`,
    embedding: fakeEmbed(i + 10),
    metadata: {},
    source_updated: new Date(),
  }));
  await upsertChunks(chunks);
  await deleteBySource("notion", sourceId);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT count(*) FROM brain_chunks WHERE source_id=$1`,
    [sourceId],
  );
  assert.equal(rows[0].count, "0");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL — storage module missing.

- [ ] **Step 3: Implement**

```typescript
// src/rag/storage.ts
import pg from "pg";
import type { ChunkWithEmbedding, Chunk, SearchHit, SearchFilters } from "./types.js";
import { formatVector, parseVector } from "./embeddings.js";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function upsertChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
  if (chunks.length === 0) return;
  const p = getPool();
  const sql = `
    INSERT INTO brain_chunks
      (id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
       text, embedding, metadata, source_updated, indexed_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb, $11, now())
    ON CONFLICT (id) DO UPDATE SET
      source_type    = EXCLUDED.source_type,
      source_id      = EXCLUDED.source_id,
      workspace      = EXCLUDED.workspace,
      db_name        = EXCLUDED.db_name,
      parent_url     = EXCLUDED.parent_url,
      chunk_index    = EXCLUDED.chunk_index,
      text           = EXCLUDED.text,
      embedding      = EXCLUDED.embedding,
      metadata       = EXCLUDED.metadata,
      source_updated = EXCLUDED.source_updated,
      indexed_at     = now()
  `;
  for (const c of chunks) {
    await p.query(sql, [
      c.id,
      c.source_type,
      c.source_id,
      c.workspace,
      c.db_name,
      c.parent_url,
      c.chunk_index,
      c.text,
      formatVector(c.embedding),
      JSON.stringify(c.metadata),
      c.source_updated,
    ]);
  }
}

export async function deleteBySource(sourceType: string, sourceId: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM brain_chunks WHERE source_type=$1 AND source_id=$2`, [
    sourceType,
    sourceId,
  ]);
}

export async function getSyncState(sourceType: string): Promise<Date> {
  const p = getPool();
  const { rows } = await p.query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM sync_state WHERE source_type=$1`,
    [sourceType],
  );
  return rows[0]?.last_sync_at ?? new Date(0);
}

export async function setSyncState(sourceType: string, ts: Date): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO sync_state (source_type, last_sync_at)
     VALUES ($1, $2)
     ON CONFLICT (source_type) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at`,
    [sourceType, ts],
  );
}

interface QueryRow {
  id: string;
  source_type: string;
  source_id: string;
  workspace: string | null;
  db_name: string | null;
  parent_url: string | null;
  chunk_index: number;
  text: string;
  metadata: Record<string, unknown>;
  source_updated: Date | null;
  score: number;
}

function rowToChunk(r: QueryRow): Chunk {
  return {
    id: r.id,
    source_type: r.source_type as Chunk["source_type"],
    source_id: r.source_id,
    workspace: r.workspace as Chunk["workspace"],
    db_name: r.db_name,
    parent_url: r.parent_url,
    chunk_index: r.chunk_index,
    text: r.text,
    metadata: r.metadata,
    source_updated: r.source_updated,
  };
}

function buildFilterClauses(
  filters: SearchFilters | undefined,
  startIdx: number,
): { sql: string; params: unknown[] } {
  if (!filters) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  if (filters.workspace) {
    clauses.push(`workspace = $${i++}`);
    params.push(filters.workspace);
  }
  if (filters.db) {
    clauses.push(`db_name = $${i++}`);
    params.push(filters.db);
  }
  if (filters.frente) {
    clauses.push(`metadata->>'frente' = $${i++}`);
    params.push(filters.frente);
  }
  if (filters.date_from) {
    clauses.push(`(metadata->>'data')::date >= $${i++}::date`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push(`(metadata->>'data')::date <= $${i++}::date`);
    params.push(filters.date_to);
  }
  if (filters.pessoa) {
    clauses.push(`metadata->'pessoas' @> $${i++}::jsonb`);
    params.push(JSON.stringify([filters.pessoa]));
  }
  return {
    sql: clauses.length ? "AND " + clauses.join(" AND ") : "",
    params,
  };
}

export async function searchSemantic(
  queryEmbedding: number[],
  filters: SearchFilters | undefined,
  topK: number,
): Promise<{ chunk: Chunk; rank: number }[]> {
  const p = getPool();
  const filterClauses = buildFilterClauses(filters, 3);
  const sql = `
    SELECT
      id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
      text, metadata, source_updated,
      1 - (embedding <=> $1::vector) AS score
    FROM brain_chunks
    WHERE embedding IS NOT NULL
      ${filterClauses.sql}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  const { rows } = await p.query<QueryRow>(sql, [
    formatVector(queryEmbedding),
    topK,
    ...filterClauses.params,
  ]);
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1 }));
}

export async function searchKeyword(
  queryText: string,
  filters: SearchFilters | undefined,
  topK: number,
): Promise<{ chunk: Chunk; rank: number }[]> {
  const p = getPool();
  const filterClauses = buildFilterClauses(filters, 3);
  const sql = `
    SELECT
      id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
      text, metadata, source_updated,
      ts_rank(tsv, plainto_tsquery('portuguese', $1)) AS score
    FROM brain_chunks
    WHERE tsv @@ plainto_tsquery('portuguese', $1)
      ${filterClauses.sql}
    ORDER BY ts_rank(tsv, plainto_tsquery('portuguese', $1)) DESC
    LIMIT $2
  `;
  const { rows } = await p.query<QueryRow>(sql, [
    queryText,
    topK,
    ...filterClauses.params,
  ]);
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1 }));
}

export async function getNeighbors(sourceId: string, chunkIndex: number): Promise<Chunk[]> {
  const p = getPool();
  const { rows } = await p.query<QueryRow>(
    `SELECT id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
            text, metadata, source_updated
     FROM brain_chunks
     WHERE source_id=$1 AND chunk_index IN ($2, $3)
     ORDER BY chunk_index`,
    [sourceId, chunkIndex - 1, chunkIndex + 1],
  );
  return rows.map(rowToChunk);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```
Expected: storage tests PASS (assumes Postgres reachable via POSTGRES_URL).

- [ ] **Step 5: Commit**

```bash
git add src/rag/storage.ts src/rag/__tests__/storage.test.ts
git commit -m "add Postgres storage layer for chunks (upsert/delete/search)"
```

---

## Task 7: Notion source adapter

**Files:**
- Create: `src/rag/notion-source.ts`

> **No tests for this task** — it's a thin adapter over the existing `clients.ts` Notion client. Validation happens via the smoke test (Task 12).

- [ ] **Step 1: Implement**

```typescript
// src/rag/notion-source.ts
import { Client as NotionClient } from "@notionhq/client";
import { createHash } from "node:crypto";
import type { IndexableDocument, Workspace } from "./types.js";

interface FetchOpts {
  workspace: Workspace;
  notionToken: string;
  modifiedSince?: Date;       // null = full reindex
  databaseIds?: string[];     // explicit list; if undefined, queries all visible DBs
}

const DEFAULT_DATABASES_PERSONAL: { id: string; name: string }[] = [
  { id: "160d4836-53f1-41a3-b20a-0aaa42adb9cd", name: "Diario Semanal" },
  { id: "33a07ba5-bee8-81ed-acfb-ffdadfab353f", name: "Reunioes" },
  { id: "33a07ba5-bee8-81a4-b929-c8bc631ccba5", name: "Insights" },
  { id: "d5650545-161f-4d32-a706-360a9a5b7af2", name: "Decisoes" },
  { id: "33a07ba5-bee8-8143-8f06-e95be84ab113", name: "Projetos" },
  { id: "33a07ba5-bee8-81ff-bec4-eeb4234688f1", name: "Pessoas" },
  { id: "33a07ba5-bee8-813f-a58f-f0fe1055eec4", name: "Organizacoes" },
  { id: "33d07ba5-bee8-812c-9563-fc48b665e2f1", name: "Academia" },
  { id: "30d07ba5-bee8-8054-b8e4-d76a35b476b5", name: "Tasks Tracker" },
];

export async function* fetchPersonalDocuments(
  opts: FetchOpts,
): AsyncGenerator<IndexableDocument> {
  const notion = new NotionClient({ auth: opts.notionToken });
  const dbs =
    opts.databaseIds?.map((id) => ({ id, name: "Custom" })) ?? DEFAULT_DATABASES_PERSONAL;

  for (const db of dbs) {
    let cursor: string | undefined = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: db.id,
        start_cursor: cursor,
        page_size: 50,
        ...(opts.modifiedSince
          ? {
              filter: {
                timestamp: "last_edited_time",
                last_edited_time: { on_or_after: opts.modifiedSince.toISOString() },
              } as any,
            }
          : {}),
      });
      for (const page of resp.results) {
        if (!("properties" in page)) continue;
        const text = await pageToText(notion, page);
        if (!text.trim()) continue;
        yield {
          source_type: "notion",
          source_id: page.id,
          workspace: opts.workspace,
          db_name: db.name,
          parent_url: (page as any).url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
          text,
          metadata: extractMetadata(page),
          source_updated: new Date((page as any).last_edited_time),
        };
      }
      cursor = resp.next_cursor ?? undefined;
    } while (cursor);
  }
}

async function pageToText(notion: NotionClient, page: any): Promise<string> {
  const lines: string[] = [];
  // Title
  for (const [_, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      lines.push("# " + prop.title.map((t: any) => t.plain_text).join(""));
    }
  }
  // Properties summary (small text props worth indexing)
  for (const [name, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "rich_text" && prop.rich_text?.length) {
      const txt = prop.rich_text.map((t: any) => t.plain_text).join("");
      if (txt.trim()) lines.push(`**${name}:** ${txt}`);
    } else if (prop.type === "select" && prop.select?.name) {
      lines.push(`**${name}:** ${prop.select.name}`);
    } else if (prop.type === "multi_select" && prop.multi_select?.length) {
      lines.push(`**${name}:** ${prop.multi_select.map((s: any) => s.name).join(", ")}`);
    }
  }
  // Body blocks
  let cursor: string | undefined = undefined;
  do {
    const blocks = await notion.blocks.children.list({
      block_id: page.id,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of blocks.results) {
      const txt = blockText(b);
      if (txt) lines.push(txt);
    }
    cursor = blocks.next_cursor ?? undefined;
  } while (cursor);
  return lines.join("\n\n");
}

function blockText(block: any): string {
  const t = block.type;
  const data = block[t];
  if (!data) return "";
  const text = (data.rich_text ?? [])
    .map((r: any) => r.plain_text)
    .join("");
  if (!text.trim()) return "";
  switch (t) {
    case "heading_1":
      return "# " + text;
    case "heading_2":
      return "## " + text;
    case "heading_3":
      return "### " + text;
    case "bulleted_list_item":
    case "numbered_list_item":
      return "- " + text;
    case "to_do":
      return (data.checked ? "[x] " : "[ ] ") + text;
    case "toggle":
    case "callout":
    case "quote":
    case "paragraph":
    default:
      return text;
  }
}

function extractMetadata(page: any): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries<any>(page.properties)) {
    if (prop.type === "select" && prop.select?.name) meta[name.toLowerCase()] = prop.select.name;
    else if (prop.type === "multi_select")
      meta[name.toLowerCase()] = prop.multi_select?.map((s: any) => s.name) ?? [];
    else if (prop.type === "date" && prop.date?.start) meta["data"] = prop.date.start;
    else if (prop.type === "people" && prop.people?.length)
      meta["pessoas"] = prop.people.map((p: any) => p.name).filter(Boolean);
  }
  // Normalize known "Frente" key
  if (typeof meta["frente"] === "string") meta["frente"] = meta["frente"];
  if (Array.isArray(meta["frentes"]) && !meta["frente"]) meta["frente"] = (meta["frentes"] as string[])[0];
  return meta;
}

export function chunkId(sourceId: string, chunkIndex: number): string {
  return createHash("sha1").update(`${sourceId}:${chunkIndex}`).digest("hex");
}
```

- [ ] **Step 2: Build to verify types**

```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/rag/notion-source.ts
git commit -m "add Notion source adapter for personal workspace"
```

---

## Task 8: Indexer orchestrator

**Files:**
- Create: `src/rag/indexer.ts`

- [ ] **Step 1: Implement**

```typescript
// src/rag/indexer.ts
import { fetchPersonalDocuments, chunkId } from "./notion-source.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { upsertChunks, deleteBySource, getSyncState, setSyncState } from "./storage.js";
import type { ChunkWithEmbedding, IndexableDocument } from "./types.js";

interface IndexerStats {
  documents: number;
  chunks: number;
  apiCalls: number;
  startedAt: Date;
  endedAt: Date;
}

export async function runDeltaSync(opts: { fullReindex?: boolean } = {}): Promise<IndexerStats> {
  const startedAt = new Date();
  const sourceType = "notion-personal";
  const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
  const token = process.env.NOTION_PERSONAL_TOKEN;
  if (!token) throw new Error("NOTION_PERSONAL_TOKEN not set");

  let documents = 0;
  const allChunks: ChunkWithEmbedding[] = [];
  const docsToReplace: string[] = [];

  for await (const doc of fetchPersonalDocuments({
    workspace: "personal",
    notionToken: token,
    modifiedSince: opts.fullReindex ? undefined : lastSync,
  })) {
    documents++;
    const docChunks = await indexDocument(doc);
    docsToReplace.push(doc.source_id);
    allChunks.push(...docChunks);
  }

  // Replace strategy: delete old chunks for these source_ids, then upsert new
  for (const id of docsToReplace) {
    await deleteBySource("notion", id);
  }
  await upsertChunks(allChunks);
  await setSyncState(sourceType, startedAt);

  return {
    documents,
    chunks: allChunks.length,
    apiCalls: Math.ceil(allChunks.length / 128),
    startedAt,
    endedAt: new Date(),
  };
}

async function indexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]> {
  const texts = chunkText(doc.text);
  if (texts.length === 0) return [];

  const embeddings = await batchEmbed(texts);
  return texts.map((text, idx) => ({
    id: chunkId(doc.source_id, idx),
    source_type: doc.source_type,
    source_id: doc.source_id,
    workspace: doc.workspace,
    db_name: doc.db_name,
    parent_url: doc.parent_url,
    chunk_index: idx,
    text,
    embedding: embeddings[idx],
    metadata: doc.metadata,
    source_updated: doc.source_updated,
  }));
}
```

- [ ] **Step 2: Build to verify types**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/rag/indexer.ts
git commit -m "add indexer orchestrator (delta sync for Notion personal)"
```

---

## Task 9: Hybrid search with RRF (TDD)

**Files:**
- Create: `src/rag/__tests__/search.test.ts`
- Create: `src/rag/search.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/rag/__tests__/search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion } from "../search.js";
import type { Chunk } from "../types.js";

const mk = (id: string): Chunk => ({
  id,
  source_type: "notion",
  source_id: id,
  workspace: "personal",
  db_name: null,
  parent_url: null,
  chunk_index: 0,
  text: id,
  metadata: {},
  source_updated: null,
});

test("RRF combines two lists and ranks shared items higher", () => {
  const a = [mk("X"), mk("Y"), mk("Z")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const b = [mk("Y"), mk("W"), mk("X")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const out = reciprocalRankFusion([a, b], 4, 60);
  // Y is rank 2 in A and rank 1 in B → score = 1/62 + 1/61 ≈ 0.0326
  // X is rank 1 in A and rank 3 in B → score = 1/61 + 1/63 ≈ 0.0322
  // So Y should beat X
  assert.equal(out[0].chunk.id, "Y");
  assert.equal(out[1].chunk.id, "X");
  assert.ok(out.length === 4);
});

test("RRF handles single list (passthrough order)", () => {
  const a = [mk("A"), mk("B"), mk("C")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const out = reciprocalRankFusion([a], 3, 60);
  assert.deepEqual(out.map((h) => h.chunk.id), ["A", "B", "C"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```
Expected: FAIL — search module missing.

- [ ] **Step 3: Implement**

```typescript
// src/rag/search.ts
import {
  searchSemantic,
  searchKeyword,
  getNeighbors,
} from "./storage.js";
import { embedQuery } from "./embeddings.js";
import type { Chunk, SearchFilters, SearchHit, SearchMode } from "./types.js";

export interface RankedChunk {
  chunk: Chunk;
  rank: number;
}

export function reciprocalRankFusion(
  lists: RankedChunk[][],
  topK: number,
  k = 60,
): SearchHit[] {
  const scores = new Map<string, { chunk: Chunk; score: number }>();
  for (const list of lists) {
    for (const { chunk, rank } of list) {
      const prev = scores.get(chunk.id);
      const incr = 1 / (k + rank);
      if (prev) prev.score += incr;
      else scores.set(chunk.id, { chunk, score: incr });
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ chunk: s.chunk, score: s.score }));
}

export interface SearchOptions {
  topK?: number;
  mode?: SearchMode;
  filters?: SearchFilters;
  includeNeighbors?: boolean;
}

export async function brainSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 12;
  const mode = opts.mode ?? "hybrid";

  let hits: SearchHit[] = [];

  if (mode === "semantic" || mode === "hybrid") {
    const qEmbed = await embedQuery(query);
    const semHits = await searchSemantic(qEmbed, opts.filters, topK * 3);
    if (mode === "semantic") {
      hits = semHits.slice(0, topK).map((h) => ({ chunk: h.chunk, score: 1 / h.rank }));
    } else {
      const kwHits = await searchKeyword(query, opts.filters, topK * 3);
      hits = reciprocalRankFusion([semHits, kwHits], topK);
    }
  } else {
    // keyword only
    const kwHits = await searchKeyword(query, opts.filters, topK);
    hits = kwHits.map((h) => ({ chunk: h.chunk, score: 1 / h.rank }));
  }

  if (opts.includeNeighbors) {
    for (const hit of hits) {
      hit.neighbors = await getNeighbors(hit.chunk.source_id, hit.chunk.chunk_index);
    }
  }

  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```
Expected: RRF tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rag/search.ts src/rag/__tests__/search.test.ts
git commit -m "add hybrid search with reciprocal rank fusion"
```

---

## Task 10: Register `brain_search` MCP tool

**Files:**
- Create: `src/rag/brain-tool.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement the tool registration**

```typescript
// src/rag/brain-tool.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { brainSearch } from "./search.js";
import type { SearchFilters } from "./types.js";

const filtersSchema = z
  .object({
    workspace: z.enum(["personal", "globalcripto", "nora"]).optional(),
    db: z.string().optional(),
    frente: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    pessoa: z.string().optional(),
  })
  .optional();

export function registerBrainSearchTool(server: McpServer): void {
  server.tool(
    "brain_search",
    `Search Bruno's second brain (Notion personal workspace in Fase 1; Granola, Calendar, and other workspaces in Fase 2).
Hybrid retrieval combines semantic vector search with PT-BR full-text. Returns chunks with metadata, scores, and source URLs.

Use cases:
- Lookup pontual: pass a specific question, get matching chunks.
- Sintese: pass a topic, retrieve enough chunks to summarize across.
- Conexao: pass an entity name and date range, find related items.`,
    {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(50).default(12),
      mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
      include_neighbors: z.boolean().default(false),
      filters: filtersSchema,
    },
    async (args) => {
      const filters = args.filters as SearchFilters | undefined;
      const hits = await brainSearch(args.query, {
        topK: args.top_k,
        mode: args.mode,
        filters,
        includeNeighbors: args.include_neighbors,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: args.query,
                mode: args.mode,
                results: hits.map((h) => ({
                  text: h.chunk.text,
                  score: h.score,
                  notion_url: h.chunk.parent_url,
                  source_type: h.chunk.source_type,
                  workspace: h.chunk.workspace,
                  db: h.chunk.db_name,
                  metadata: h.chunk.metadata,
                  neighbors: h.neighbors?.map((n) => n.text) ?? [],
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
```

- [ ] **Step 2: Wire it into `src/index.ts`**

Add this import near the existing `registerTools` import:

```typescript
import { registerBrainSearchTool } from "./rag/brain-tool.js";
```

And in the `McpServer` setup block (where `registerTools(server)` is called), add right after:

```typescript
  registerTools(server);
  registerBrainSearchTool(server);
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/rag/brain-tool.ts src/index.ts
git commit -m "register brain_search as MCP tool on notion-mcp"
```

---

## Task 11: Indexer entrypoint and PM2 config

**Files:**
- Create: `src/index-indexer.ts`
- Modify: `ecosystem.config.cjs`

- [ ] **Step 1: Implement the indexer entrypoint**

```typescript
// src/index-indexer.ts
import "dotenv/config";
import cron from "node-cron";
import { runDeltaSync } from "./rag/indexer.js";

const CRON_EXPR = process.env.INDEXER_CRON ?? "0 * * * *"; // top of every hour

async function tick(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runDeltaSync();
    console.log(
      `[${new Date().toISOString()}] [${label}] documents=${stats.documents} chunks=${stats.chunks} apiCalls=${stats.apiCalls} took=${Date.now() - start}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${label}] FAILED`, err);
  }
}

console.log(`brain-indexer starting; cron: ${CRON_EXPR}`);
console.log("running initial tick on startup...");
void tick("initial");

cron.schedule(CRON_EXPR, () => {
  void tick("cron");
});
```

- [ ] **Step 2: Update `ecosystem.config.cjs`**

```javascript
module.exports = {
  apps: [
    {
      name: "notion-mcp",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: 3456,
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: "brain-indexer",
      script: "dist/index-indexer.js",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 10000,
      max_restarts: 5,
    },
  ],
};
```

- [ ] **Step 3: Build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/index-indexer.ts ecosystem.config.cjs
git commit -m "add brain-indexer PM2 process with cron scheduler"
```

---

## Task 12: Smoke test E2E

**Files:**
- Create: `scripts/reindex-all.mts`

> **Goal:** prove the whole pipeline works against real data on Bruno's VPS. This is the moment of truth for Fase 1.

- [ ] **Step 1: Implement reindex script**

```typescript
// scripts/reindex-all.mts
import "dotenv/config";
import { runDeltaSync } from "../src/rag/indexer.js";
import { brainSearch } from "../src/rag/search.js";
import { closePool } from "../src/rag/storage.js";

async function main() {
  console.log("=== Full reindex (personal workspace) ===");
  const stats = await runDeltaSync({ fullReindex: true });
  console.log(JSON.stringify(stats, null, 2));

  console.log("\n=== Smoke queries ===");
  for (const q of ["Talos", "stablecoin BRS", "Pinheiro Neto stock options", "fechamento semanal"]) {
    const hits = await brainSearch(q, { topK: 3, mode: "hybrid" });
    console.log(`\nQuery: "${q}"`);
    hits.forEach((h, i) =>
      console.log(
        `  ${i + 1}. score=${h.score.toFixed(4)} db=${h.chunk.db_name} url=${h.chunk.parent_url}\n     "${h.chunk.text.slice(0, 120).replace(/\n/g, " ")}..."`,
      ),
    );
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Deploy code to the VPS**

```bash
# from local machine
ssh root@124.198.128.68 'cd /home/moniz/notion-mcp && git pull && npm install && npm run build'
```

- [ ] **Step 3: Run the full reindex on the VPS**

```bash
ssh root@124.198.128.68 'cd /home/moniz/notion-mcp && npm run reindex'
```
Expected output:
- `documents=` between 50 and 1000 (depends on Cérebro size)
- `chunks=` ~2-5x documents
- 4 smoke queries, each returning 3 hits with non-zero scores
- "Talos" should return chunks from the Reuniões DB referencing Talos meetings

- [ ] **Step 4: Restart pm2 with new ecosystem (adds brain-indexer)**

```bash
ssh root@124.198.128.68 'cd /home/moniz/notion-mcp && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save'
ssh root@124.198.128.68 'pm2 list && pm2 logs brain-indexer --lines 30 --nostream'
```
Expected:
- Both `notion-mcp` and `brain-indexer` show `online`
- `brain-indexer` log shows the initial tick output

- [ ] **Step 5: Verify `brain_search` from Claude Code**

In Claude Code (after `claude` restart so it sees the new tool), run:

```
Use brain_search with query "Talos" and top_k=3. Show me the result.
```
Expected: tool returns 3 hits with text from Talos-related Reuniões pages.

- [ ] **Step 6: Commit and push**

```bash
git add scripts/reindex-all.mts
git commit -m "add smoke-test reindex script and complete Fase 1"
git push origin <branch-name>
```

---

## Verification checklist (Fase 1 done)

After Task 12 succeeds, all of these should be true:

- [ ] `pm2 list` shows `notion-mcp` and `brain-indexer` both online
- [ ] `psql brain -c "SELECT count(*) FROM brain_chunks WHERE workspace='personal'"` returns > 0
- [ ] `psql brain -c "SELECT count(*) FROM embedding_cache"` returns > 0 (cache populated)
- [ ] `brain_search` callable from Claude.ai (via OAuth) and Claude Code (via bearer)
- [ ] Smoke queries (Talos, BRS, etc.) return relevant chunks in top-3
- [ ] After running reindex twice in a row, second run is fast (cache hits) and chunks=0 (no changes detected since first run)

## Out of scope (Fase 2 / Fase 3)

- `globalcripto` and `nora` workspaces — duplicate the source adapter pattern, gated by token + workspace param
- Granola adapter — pull summaries via Granola API, treat each meeting as one document
- Google Calendar adapter — pull events with description, treat each event as one short document
- Web UI — separate sub-project
- Re-ranking with `voyage-rerank-2`
- Auto-prune of orphaned chunks (page deleted in Notion)

These are tracked in the spec; each gets its own plan.
