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
