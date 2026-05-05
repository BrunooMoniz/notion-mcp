// scripts/ingest-from-json.mts
// Generic ingestion script for non-Notion sources (Granola, Calendar, etc.)
// Usage: tsx scripts/ingest-from-json.mts <path-to-json>
//
// JSON format:
// {
//   "source_type": "granola" | "calendar",
//   "documents": [
//     {
//       "source_type": "granola",
//       "source_id": "uuid",
//       "workspace": null | "personal" | "globalcripto" | "nora",
//       "db_name": "Granola",
//       "parent_url": "https://...",
//       "text": "full document text",
//       "metadata": { ... },
//       "source_updated": "2026-04-29T12:00:00Z"
//     }
//   ]
// }

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chunkText } from "../src/rag/chunker.js";
import { batchEmbed } from "../src/rag/embeddings.js";
import { upsertChunks, deleteBySource, setSyncState, closePool } from "../src/rag/storage.js";
import type { ChunkWithEmbedding, IndexableDocument, SourceType } from "../src/rag/types.js";

function chunkId(sourceId: string, chunkIndex: number): string {
  return createHash("sha1").update(`${sourceId}:${chunkIndex}`).digest("hex");
}

interface InputDoc {
  source_type: SourceType;
  source_id: string;
  workspace: IndexableDocument["workspace"];
  db_name: string | null;
  parent_url: string;
  text: string;
  metadata: Record<string, unknown>;
  source_updated: string;
}

async function indexDocument(doc: InputDoc): Promise<ChunkWithEmbedding[]> {
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
    source_updated: new Date(doc.source_updated),
  }));
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: tsx scripts/ingest-from-json.mts <path-to-json>");
    process.exit(1);
  }

  const raw = readFileSync(path, "utf-8");
  const payload = JSON.parse(raw) as { source_type: SourceType; documents: InputDoc[] };
  const sourceType = payload.source_type;
  const docs = payload.documents;

  console.log(`Ingesting ${docs.length} documents (source_type=${sourceType}) from ${path}`);

  let totalChunks = 0;
  const startedAt = new Date();

  for (const doc of docs) {
    try {
      await deleteBySource(doc.source_type, doc.source_id);
      const chunks = await indexDocument(doc);
      if (chunks.length === 0) continue;
      await upsertChunks(chunks);
      totalChunks += chunks.length;
      console.log(`  ${doc.source_id} (${(doc.metadata?.title as string | undefined) ?? doc.source_id}): ${chunks.length} chunks`);
    } catch (err: any) {
      console.error(`  ${doc.source_id} FAILED: ${err.message ?? err}`);
    }
  }

  await setSyncState(`${sourceType}-bulk`, startedAt);
  console.log(`\nTotal: ${docs.length} docs, ${totalChunks} chunks in ${Date.now() - startedAt.getTime()}ms`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
