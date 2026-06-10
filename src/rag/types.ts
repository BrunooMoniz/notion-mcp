// src/rag/types.ts

export type SourceType = "notion" | "granola" | "calendar" | "web" | "conversation";
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
  account_id?: string;         // F3.0 tenant; defaults to 'bruno' at write time
  // Spec 004: utility ranking fields (aditivo, defaults provided by DB)
  utility_score?: number;      // materialized utility score
  feedback_count?: number;     // total feedback events
  last_useful_at?: Date | null; // timestamp of last positive signal
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
  source_type?: SourceType;          // keep only this source
  exclude_source_type?: SourceType;  // drop this source (e.g. exclude calendar noise)
  /**
   * INTERNAL (F.4.2) — not part of the public tool schema. brainSearch sets this
   * from the caller's OAuth scope (getAllowedWorkspaces) intersected with the
   * caller's requested workspace. When present, the SQL hard-restricts to
   * `workspace = ANY($N)`; an empty array means zero rows (secure default, no
   * cross-workspace leak). When undefined, no scope restriction is applied
   * (bearer "all" token, cron, eval, tests). Callers must never set this from
   * untrusted input.
   */
  _allowedWorkspaces?: Workspace[];
  /**
   * INTERNAL (F3.0) — tenant isolation. brainSearch sets this from the trusted
   * request context (getAccountId), NEVER from tool input. When present, the SQL
   * AND-restricts to `account_id = $N` ALONGSIDE the workspace guard (defense in
   * depth). When undefined, no account restriction (cron/eval/tests).
   */
  _accountId?: string;
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
  parent_url: string | null;   // null for sources with no per-item URL (conversation)
  text: string;                // full document text — chunker splits it
  metadata: Record<string, unknown>;
  source_updated: Date;
  account_id?: string;         // F3.0 tenant; defaults to 'bruno' at write time
}

// --- F2.2: pluggable connector framework ------------------------------------
// A `Source` is a self-contained connector that yields IndexableDocuments. The
// generic pass runner (src/rag/sources/runner.ts) drives any Source through the
// same chunk→embed→delete→upsert→sync-state→record-run lifecycle the three
// built-in passes already use — no per-source plumbing in the indexer.

export interface SourcePassOptions {
  fullReindex?: boolean;
  modifiedSince?: Date;
}

export interface Source {
  /** stable key for sync_state + status_runs, e.g. "web" */
  readonly name: string;
  /** bare source_type written to brain_chunks */
  readonly sourceType: SourceType;
  /** is this source configured/enabled in the current env? */
  isConfigured(): boolean;
  listDocuments(opts: SourcePassOptions): AsyncIterable<IndexableDocument>;
}
