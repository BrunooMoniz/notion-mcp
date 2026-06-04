// src/rag/context-header.ts
// "Contextual retrieval" — derive a compact, deterministic provenance header
// from a document's existing metadata. The header is prepended to every chunk
// before embedding/storage so each chunk is self-describing for the embedding
// model, the Portuguese full-text index, and the LLM/planner reading results.
// PURE: no IO, no LLM calls — everything comes from `doc`.

import type { IndexableDocument } from "./types.js";

/**
 * Build a single-line provenance header for a document.
 *
 * Shape: `[${db_name} · ${workspace} · ${YYYY-MM-DD} · ${frente}] ${title}`
 * where any empty part is dropped. With no parts it is just the title; with no
 * title it is just the bracket; with neither it is "".
 */
export function buildContextHeader(doc: IndexableDocument): string {
  const title = deriveTitle(doc);

  const parts: string[] = [];
  if (doc.db_name) parts.push(doc.db_name);
  if (doc.workspace) parts.push(doc.workspace);
  const date = truncateDate(doc.metadata.data);
  if (date) parts.push(date);
  if (typeof doc.metadata.frente === "string" && doc.metadata.frente.trim()) {
    parts.push(doc.metadata.frente.trim());
  }

  const bracket = parts.length > 0 ? `[${parts.join(" · ")}]` : "";
  return `${bracket} ${title}`.trim();
}

function deriveTitle(doc: IndexableDocument): string {
  for (const line of doc.text.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)/);
    if (m) return m[1].trim();
  }
  return String(doc.metadata.title ?? "").trim();
}

// Truncate an ISO-ish date string to YYYY-MM-DD. Returns "" for anything that
// doesn't start with a YYYY-MM-DD prefix (e.g. null, undefined, non-string).
function truncateDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}
