// src/rag/gcal-oauth-source.ts
// RAG source para eventos das contas Google OAuth (vault kind "google_oauth").
// Para cada conta google_oauth do account Zinom: lista agendas, busca eventos na
// janela [hoje-90d, hoje+180d], gera 1 documento por evento.
//
// Convenções:
//   source_type: "calendar"
//   source_id:   "gcal:<email>:<eventId>"  (upsert idempotente)
//   Evento status "cancelled": deletar chunks daquele source_id.
//   Falha em uma conta NÃO derruba as demais: coleta erros e reporta no recordRun.
//   sync_state source_type: "gcal"

import type { IndexableDocument } from "./types.js";
import type { CalendarEvent, CalendarListEntry } from "../google/calendar.js";
import type { GoogleAccountEntry } from "../google/google-accounts.js";
import type { ChunkWithEmbedding } from "./types.js";

// ─── Tombstone marker ───────────────────────────────────────────────────────
// Eventos cancelados não geram IndexableDocument real: são sinalizados com este
// marcador para que o chamador saiba que deve deletar os chunks.

export interface GcalTombstone {
  source_id: string;
  _deleted: true;
}

export type GcalDocOrTombstone = (IndexableDocument & { _deleted?: false }) | (IndexableDocument & { _deleted: true });

// ─── Funções puras ──────────────────────────────────────────────────────────

/** Janela de busca: [hoje-90d, hoje+180d] como strings ISO 8601. */
export function gcalWindow(now: Date = new Date()): { timeMin: string; timeMax: string } {
  const min = new Date(now);
  min.setDate(min.getDate() - 90);
  const max = new Date(now);
  max.setDate(max.getDate() + 180);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

function attendeeEmails(ev: CalendarEvent): string[] {
  if (!ev.attendees) return [];
  return ev.attendees.map((a) => a.email ?? "").filter(Boolean);
}

function formatEventDate(ev: CalendarEvent): { dateStr: string; allDay: boolean } {
  const start = ev.start;
  if (!start) return { dateStr: "", allDay: false };
  if (start.date) {
    // all-day event
    return { dateStr: start.date, allDay: true };
  }
  if (start.dateTime) {
    // timed event — store as YYYY-MM-DD in metadata.data
    return { dateStr: new Date(start.dateTime).toISOString().slice(0, 10), allDay: false };
  }
  return { dateStr: "", allDay: false };
}

function buildEventText(ev: CalendarEvent, email: string, calSummary: string): string {
  const lines: string[] = [];
  lines.push(`# ${ev.summary ?? "(sem título)"}`);

  const start = ev.start;
  if (start) {
    const when = start.date ?? start.dateTime ?? "";
    if (when) lines.push(`**Quando:** ${when}`);
  }

  lines.push(`**Calendário:** ${calSummary}`);
  lines.push(`**Conta:** ${email}`);

  if (ev.location) lines.push(`**Local:** ${ev.location}`);

  const emails = attendeeEmails(ev);
  if (emails.length > 0) lines.push(`**Participantes:** ${emails.join(", ")}`);

  if (ev.description) {
    const desc = ev.description
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (desc) {
      lines.push("");
      lines.push("## Descrição");
      lines.push(desc.slice(0, 2000));
    }
  }

  return lines.join("\n");
}

/**
 * Mapeia um CalendarEvent para IndexableDocument (ou tombstone se cancelled).
 * Função pura: sem I/O, determinística dado o input.
 */
export function eventToDocument(
  ev: CalendarEvent,
  email: string,
  calSummary: string,
): IndexableDocument & { _deleted?: boolean } {
  const sourceId = `gcal:${email}:${ev.id}`;
  const isCancelled = (ev.status ?? "").toLowerCase() === "cancelled";

  if (isCancelled) {
    // Tombstone: o chamador deve deletar os chunks desse source_id.
    return {
      source_type: "calendar",
      source_id: sourceId,
      workspace: null,
      db_name: calSummary,
      parent_url: ev.htmlLink ?? "",
      text: "",
      metadata: { email, data: "", attendees: [] },
      source_updated: new Date(),
      _deleted: true,
    };
  }

  const { dateStr, allDay: _allDay } = formatEventDate(ev);
  const text = buildEventText(ev, email, calSummary);
  const emails = attendeeEmails(ev);

  return {
    source_type: "calendar",
    source_id: sourceId,
    workspace: null,
    db_name: calSummary,
    parent_url: ev.htmlLink ?? "",
    text,
    metadata: {
      data: dateStr,
      email,
      attendees: emails,
    },
    source_updated: new Date(),
    _deleted: false,
  };
}

// ─── Deps injetáveis ────────────────────────────────────────────────────────

export interface GcalDeps {
  getGoogleAccounts(accountId: string): Promise<GoogleAccountEntry[]>;
  getAccessToken(accountId: string, email: string): Promise<string>;
  listCalendarsWithToken(token: string): Promise<CalendarListEntry[]>;
  listEventsWithToken(
    token: string,
    opts: { calendarId: string; timeMin: string; timeMax: string },
  ): Promise<CalendarEvent[]>;
  indexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]>;
  replaceDocumentChunks(
    sourceType: string,
    sourceId: string,
    accountId: string,
    chunks: ChunkWithEmbedding[],
  ): Promise<void>;
  deleteBySource(sourceType: string, sourceId: string, accountId: string): Promise<void>;
  setSyncState(key: string, ts: Date, accountId: string): Promise<void>;
  recordRun(run: {
    worker: string;
    source: string;
    ok: boolean;
    counts?: unknown;
    error?: string | null;
    startedAt: Date;
    endedAt: Date;
    accountId?: string;
  }): Promise<void>;
  ensureAccountWorkspace(accountId: string, workspace: string): Promise<void>;
}

// Lazy real deps — carregados sob demanda para não quebrar imports em testes
async function buildRealDeps(): Promise<GcalDeps> {
  const [
    { getGoogleAccounts },
    { getGoogleAccessTokenFor },
    { listCalendarsWithToken, listEventsWithToken },
    { indexDocument },
    { replaceDocumentChunks, deleteBySource, setSyncState, recordRun },
    { ensureAccountWorkspace },
  ] = await Promise.all([
    import("../google/google-accounts.js"),
    import("../google/google-token.js"),
    import("../google/calendar.js"),
    import("./index-document.js"),
    import("./storage.js"),
    import("./account-sources.js"),
  ]);

  return {
    getGoogleAccounts,
    getAccessToken: (accountId, email) => getGoogleAccessTokenFor(accountId, email),
    listCalendarsWithToken,
    listEventsWithToken,
    indexDocument,
    replaceDocumentChunks,
    deleteBySource,
    setSyncState: (key, ts, accountId) => setSyncState(key, ts, accountId),
    recordRun,
    ensureAccountWorkspace,
  };
}

// Seam de teste: substituir deps sem afetar produção.
let _testDeps: GcalDeps | null = null;

/** Test-only: injeta deps ou limpa (null) após o teste. */
export function __setGcalDepsForTest(deps: GcalDeps | null): void {
  _testDeps = deps;
}

async function getDeps(): Promise<GcalDeps> {
  return _testDeps ?? buildRealDeps();
}

// ─── indexGcalOAuthForAccount ───────────────────────────────────────────────

/**
 * Indexa os eventos de TODAS as contas Google OAuth de um account Zinom.
 * Falha em uma conta Google NÃO derruba as demais.
 * Retorna contagem total de documentos/chunks indexados.
 */
export async function indexGcalOAuthForAccount(
  accountId: string,
  workspace: string,
): Promise<{ documents: number; chunks: number }> {
  const deps = await getDeps();
  const startedAt = new Date();
  let documents = 0;
  let chunks = 0;
  const errors: string[] = [];

  const accounts = await deps.getGoogleAccounts(accountId);

  if (accounts.length > 0) {
    await deps.ensureAccountWorkspace(accountId, workspace);
  }

  const { timeMin, timeMax } = gcalWindow();

  for (const acct of accounts) {
    try {
      const token = await deps.getAccessToken(accountId, acct.email);
      const calendars = await deps.listCalendarsWithToken(token);

      for (const cal of calendars) {
        const calId = cal.id;
        const calSummary = cal.summary ?? calId;
        let events: CalendarEvent[];
        try {
          events = await deps.listEventsWithToken(token, {
            calendarId: calId,
            timeMin,
            timeMax,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${acct.email}/${calId}: ${msg}`);
          continue;
        }

        for (const ev of events) {
          if (!ev.id) continue;
          const sourceId = `gcal:${acct.email}:${ev.id}`;

          if ((ev.status ?? "").toLowerCase() === "cancelled") {
            await deps.deleteBySource("calendar", sourceId, accountId);
            continue;
          }

          const doc = eventToDocument(ev, acct.email, calSummary);
          // Remover flag _deleted do objeto antes de passar ao indexer
          const { _deleted: _ignored, ...cleanDoc } = doc as IndexableDocument & { _deleted?: boolean };
          // Garantir workspace tag para armazenamento
          cleanDoc.workspace = workspace as typeof cleanDoc.workspace;
          cleanDoc.account_id = accountId;

          try {
            const docChunks = await deps.indexDocument(cleanDoc);
            await deps.replaceDocumentChunks("calendar", sourceId, accountId, docChunks);
            documents++;
            chunks += docChunks.length;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${acct.email}/${ev.id}: ${msg}`);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${acct.email}: ${msg}`);
    }
  }

  // Apenas registra sync_state e run se houve contas para processar
  if (accounts.length > 0 || errors.length > 0) {
    await deps.setSyncState("gcal", startedAt, accountId);
    const ok = errors.length === 0;
    await deps.recordRun({
      worker: "indexer",
      source: "gcal",
      ok,
      counts: { documents, chunks, errors: errors.length },
      error: errors.length > 0 ? errors.join(" | ") : null,
      startedAt,
      endedAt: new Date(),
      accountId,
    });
  }

  return { documents, chunks };
}
