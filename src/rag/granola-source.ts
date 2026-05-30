// src/rag/granola-source.ts
// Pulls Granola meeting notes (summary + transcript) via the public API and
// yields IndexableDocument records. Used by the brain-indexer cron.
//
// Granola API (https://docs.granola.ai/introduction):
//   Base: https://public-api.granola.ai/v1
//   Auth: Authorization: Bearer grn_<key>
//   List: GET /notes?created_after=ISO&cursor=...
//   Get:  GET /notes/{id}?include=transcript
//   Pagination: response has { notes: [...], hasMore, cursor }
//   Rate limit: ~5 rps sustained / 25 burst over 5s; we throttle to be safe.

import type { IndexableDocument, Workspace } from "./types.js";

const GRANOLA_BASE = "https://public-api.granola.ai/v1";
const THROTTLE_MS = 220; // ~4.5 rps — under the 5 rps sustained limit

interface GranolaNoteSummary {
  id: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface GranolaNoteFull {
  id: string;
  object?: string;
  title?: string | null;
  web_url?: string | null;
  owner?: { name?: string; email?: string };
  created_at?: string;
  updated_at?: string;
  calendar_event?: { id?: string; title?: string; start_at?: string; end_at?: string } | null;
  attendees?: Array<{ name?: string; email?: string }>;
  folder_membership?: Array<{ folder_id?: string; folder_name?: string }>;
  transcript?: Array<{ speaker?: { source?: string; diarization_label?: string }; text?: string }>;
  summary_text?: string;
  summary_markdown?: string;
  summary?: string;
}

interface ListResp {
  notes?: GranolaNoteSummary[];
  hasMore?: boolean;
  cursor?: string | null;
}

interface FetchOpts {
  tokenEnv: string;
  workspace: Workspace;
  modifiedSince?: Date;
}

async function granolaGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`${GRANOLA_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Granola HTTP ${resp.status}: ${text.slice(0, 200)}`);
    (e as any).status = resp.status;
    throw e;
  }
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// F.1.6: the raw transcript is noise (verbatim speech) and can carry sensitive
// content (e.g. salaries). We do NOT index it by default — only the summary.
// Set GRANOLA_INDEX_TRANSCRIPT=true to opt back in.
export function indexTranscriptEnabled(): boolean {
  return process.env.GRANOLA_INDEX_TRANSCRIPT === "true";
}

export function buildNoteText(note: GranolaNoteFull): string {
  const lines: string[] = [];
  lines.push(`# ${note.title ?? "(untitled)"}`);
  if (note.created_at) lines.push(`**Data:** ${note.created_at}`);
  if (note.owner?.name) lines.push(`**Owner:** ${note.owner.name}${note.owner.email ? ` <${note.owner.email}>` : ""}`);
  if (note.attendees?.length) {
    const names = note.attendees.map((a) => a.name || a.email || "").filter(Boolean);
    if (names.length) lines.push(`**Attendees:** ${names.join(", ")}`);
  }
  if (note.calendar_event?.title) {
    lines.push(`**Calendar event:** ${note.calendar_event.title}`);
  }
  const summary = note.summary_markdown || note.summary_text || note.summary || "";
  if (summary.trim()) {
    lines.push("");
    lines.push("## Summary");
    lines.push(summary.trim());
  }
  if (indexTranscriptEnabled() && note.transcript?.length) {
    lines.push("");
    lines.push("## Transcript");
    for (const entry of note.transcript) {
      const label = entry.speaker?.diarization_label ?? entry.speaker?.source ?? "Speaker";
      const text = (entry.text ?? "").trim();
      if (text) lines.push(`[${label}]: ${text}`);
    }
  }
  return lines.join("\n");
}

function noteMetadata(note: GranolaNoteFull): Record<string, unknown> {
  return {
    owner_email: note.owner?.email,
    attendees: (note.attendees ?? []).map((a) => a.name || a.email).filter(Boolean),
    folder: note.folder_membership?.[0]?.folder_name,
    calendar_event_id: note.calendar_event?.id,
    web_url: note.web_url,
  };
}

export async function* fetchGranolaDocuments(
  opts: FetchOpts,
): AsyncGenerator<IndexableDocument> {
  const token = process.env[opts.tokenEnv];
  if (!token) {
    console.warn(`[granola-source] ${opts.tokenEnv} not set; skipping`);
    return;
  }

  const since = opts.modifiedSince?.toISOString() ?? new Date(0).toISOString();
  let cursor: string | null | undefined = undefined;
  let page = 0;
  let totalListed = 0;

  do {
    const qs = new URLSearchParams({ created_after: since });
    if (cursor) qs.set("cursor", cursor);
    let listResp: ListResp;
    try {
      listResp = await granolaGet<ListResp>(`/notes?${qs.toString()}`, token);
    } catch (err: any) {
      console.warn(`[granola-source] list failed (workspace=${opts.workspace}, page=${page}): ${err.message}`);
      return;
    }
    const notes = listResp.notes ?? [];
    totalListed += notes.length;
    page += 1;
    console.log(`[granola-source] workspace=${opts.workspace} page=${page} notes=${notes.length} hasMore=${listResp.hasMore}`);

    for (const summary of notes) {
      await sleep(THROTTLE_MS);
      let full: GranolaNoteFull;
      // F.1.6: only request the transcript from the API under the same gate, so
      // the default path never even pulls the sensitive content over the wire.
      const detailPath = indexTranscriptEnabled()
        ? `/notes/${summary.id}?include=transcript`
        : `/notes/${summary.id}`;
      try {
        full = await granolaGet<GranolaNoteFull>(detailPath, token);
      } catch (err: any) {
        console.warn(`[granola-source] fetch ${summary.id} failed: ${err.message}`);
        continue;
      }
      const text = buildNoteText(full);
      if (!text.trim()) continue;

      const lastEdited =
        full.updated_at ?? full.created_at ?? summary.updated_at ?? summary.created_at ?? new Date().toISOString();

      yield {
        source_type: "granola",
        source_id: full.id,
        workspace: opts.workspace,
        db_name: "Granola",
        parent_url: full.web_url ?? `https://notes.granola.ai/d/${full.id}`,
        text,
        metadata: noteMetadata(full),
        source_updated: new Date(lastEdited),
      };
    }

    cursor = listResp.hasMore ? listResp.cursor ?? null : null;
  } while (cursor);

  console.log(`[granola-source] workspace=${opts.workspace} listed=${totalListed}`);
}
