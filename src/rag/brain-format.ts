// src/rag/brain-format.ts
// P2 — source citations. PURE formatting of brain_search hits into the result
// shape the model cites from: a human `title` and a usable `source_url` (the
// page/meeting/event link). No IO — unit-testable in isolation.
import type { SearchHit } from "./types.js";

// The misleading "link" the iCal indexer stored for events with no per-event URL:
// it points at the calendar HOME, not the event. We never cite it — dropping it
// here also cleans every already-indexed calendar chunk at READ time (no reindex).
const GENERIC_CAL_HOME = "https://calendar.google.com/calendar/r";

/** Extract a human title from a chunk's text. The indexer prepends a provenance
 *  header `[db · workspace · date · frente] Título` (context-header.ts); strip
 *  the leading bracket. Falls back to the first non-empty line, or "". */
export function titleFromChunkText(text: string): string {
  const first = (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
  const m = first.match(/^\[[^\]]*\]\s*(.*)$/);
  return (m ? m[1] : first).trim();
}

/** A citable source URL, or null. Drops empty values and the misleading generic
 *  Google Calendar home link so the model never cites a link that doesn't point
 *  at the actual source. */
export function sourceUrlOf(chunk: { parent_url: string | null; source_type: string }): string | null {
  const u = (chunk.parent_url ?? "").trim();
  if (!u) return null;
  if (chunk.source_type === "calendar" && u === GENERIC_CAL_HOME) return null;
  return u;
}

export interface BrainResult {
  title: string;
  text: string;
  score: number;
  source_url: string | null;
  /** Back-compat alias of source_url (older clients/evals read `notion_url`). */
  notion_url: string | null;
  source_type: string;
  workspace: string | null;
  db: string | null;
  metadata: Record<string, unknown>;
  neighbors: string[];
}

/** Map one search hit to the citable result object returned by brain_search. */
export function toBrainResult(hit: SearchHit): BrainResult {
  const url = sourceUrlOf(hit.chunk);
  return {
    title: titleFromChunkText(hit.chunk.text),
    text: hit.chunk.text,
    score: hit.score,
    source_url: url,
    notion_url: url,
    source_type: hit.chunk.source_type,
    workspace: hit.chunk.workspace,
    db: hit.chunk.db_name,
    metadata: hit.chunk.metadata,
    neighbors: hit.neighbors?.map((n) => n.text) ?? [],
  };
}
