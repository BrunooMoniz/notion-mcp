// src/rag/remember-doc.ts
// Objective #4 — conversation memory. The PURE document builder behind the
// `remember` MCP tool, kept in a standalone module so it can be imported in a
// credential-less unit test. (Importing remember-tool.ts would pull in search.ts
// -> notion-source -> clients.ts, which process.exit(1)s when Notion env vars are
// absent — the same constraint indexer.ts documents for granola-cursor.ts.)
//
// No IO, no Voyage, no clients.ts. Account scope + id + clock all arrive via an
// explicit seam, so the result is deterministic and the test can prove that
// account_id comes from the trusted context, never from tool input.

import { randomUUID } from "node:crypto";
import type { IndexableDocument, Workspace } from "./types.js";

/** What the assistant passes to `remember`. account_id is intentionally ABSENT —
 *  it is resolved from the request context, never from input. */
export interface RememberInput {
  text: string;
  title?: string;
  tags?: string[];
}

/** Trusted, server-derived context for building the document. Injectable so the
 *  builder is pure + deterministic in tests (id/clock seams) and so account scope
 *  provably comes from here, not from RememberInput. */
export interface RememberSeam {
  accountId: string;
  workspace: Workspace | null;
  /** stable id for the conversation source_id; omitted -> randomUUID(). */
  id?: string;
  /** clock; omitted -> new Date(). */
  now?: Date;
}

export const DEFAULT_TITLE = "Nota de conversa";

/**
 * PURE: build the IndexableDocument for a conversation note. No IO, no Voyage.
 * - source_type = "conversation"
 * - source_id   = `conversation:<id>` (deterministic from the seam's id)
 * - account_id  = seam.accountId (NEVER from input)
 * - workspace   = seam.workspace (the account's default workspace)
 * - parent_url  = null (no per-note URL; brain-format cites by title instead)
 * - metadata    = { title, tags, created (YYYY-MM-DD), data (alias for date filter) }
 */
export function buildConversationDocument(
  input: RememberInput,
  seam: RememberSeam,
): IndexableDocument {
  const id = seam.id ?? randomUUID();
  const now = seam.now ?? new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const title = (input.title ?? "").trim() || DEFAULT_TITLE;

  return {
    source_type: "conversation",
    source_id: `conversation:${id}`,
    workspace: seam.workspace,
    db_name: null,
    parent_url: null,
    text: input.text,
    metadata: {
      title,
      tags,
      created: date,
      // `data` mirrors the per-source date key the rest of the brain uses, so the
      // date filter + context header treat a conversation note like any other chunk.
      data: date,
    },
    source_updated: now,
    account_id: seam.accountId,
  };
}
