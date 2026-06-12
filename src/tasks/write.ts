// src/tasks/write.ts
// 003-tasks-v1 — canonical task writes. createTask() generalizes the old
// portal/task-write.ts buildTaskPagePayload through the TrackerProfile (any
// schema, not just the fixed standard one); updateTask() patches an existing
// page AFTER verifying it belongs to the account's tracker (isolation guard:
// a page id from another data source is a 404, never written). Pure payload
// builders are exported for tests.
import {
  loadTrackerProfile,
  invalidateTrackerProfile,
  rawNotionFetch,
  rawErrorMessage,
  resolveStatusOptionName,
  NoTrackerError,
  TaskNotFoundError,
  type TrackerProfile,
  type TrackerContext,
  type AdapterDeps,
} from "./adapter.js";
import { pageToTask } from "./read.js";
import {
  canonicalStatusFor,
  canonicalPriorityFor,
  canonicalTipoFor,
  normalize,
  PRIORITY_NAME_PT,
  TIPO_NAME_PT,
  type Task,
} from "./model.js";
import { localDateInTz, DEFAULT_TIMEZONE } from "./plan-context.js";

export interface CreateTaskInput {
  title: string;
  status?: string;
  prioridade?: string;
  prazo?: string; // ISO date or datetime (start)
  prazo_fim?: string; // ISO end (only with prazo)
  tempo_estimado_min?: number;
  tipo?: string; // 'fazer' | 'cobrar'
  quem?: string;
  origem_url?: string;
  projeto?: string;
  note?: string;
}

export interface UpdateTaskPatch {
  titulo?: string;
  status?: string;
  prioridade?: string;
  prazo?: string;
  prazo_fim?: string;
  tempo_estimado_min?: number;
  tipo?: string;
  quem?: string;
  projeto?: string;
  nota_append?: string;
}

// --- shared property-value builders (pure) --------------------------------------

function titleValue(text: string): unknown {
  return { title: [{ type: "text", text: { content: text.slice(0, 2000) } }] };
}

function richTextValue(text: string): unknown {
  return { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] };
}

/** Sets the status property + (for done, when mapped) the concluida_em date. */
function applyStatus(
  profile: TrackerProfile,
  props: Record<string, unknown>,
  value: string,
  todayISO: string,
): void {
  const sp = profile.props.status;
  if (!sp) return; // no status column: silently skip (title-only base)
  const optName = resolveStatusOptionName(sp, value);
  props[sp.name] = sp.kind === "status" ? { status: { name: optName } } : { select: { name: optName } };
  const canonical = canonicalStatusFor(optName) ?? canonicalStatusFor(value);
  if (canonical === "done" && profile.props.concluida_em) {
    props[profile.props.concluida_em.name] = { date: { start: todayISO } };
  }
}

function applyPriority(profile: TrackerProfile, props: Record<string, unknown>, value: string): void {
  const pp = profile.props.prioridade;
  if (!pp) return;
  const canonical = canonicalPriorityFor(value);
  const name = canonical ? (pp.map[canonical] ?? PRIORITY_NAME_PT[canonical]) : value;
  props[pp.name] = { select: { name } };
}

function applyTipo(profile: TrackerProfile, props: Record<string, unknown>, value: string): void {
  const tp = profile.props.tipo;
  if (!tp) return;
  const canonical = canonicalTipoFor(value);
  let name = value;
  if (canonical) {
    name = tp.options.find((o) => canonicalTipoFor(o) === canonical) ?? TIPO_NAME_PT[canonical];
  }
  props[tp.name] = { select: { name } };
}

function applyProjeto(profile: TrackerProfile, props: Record<string, unknown>, value: string): void {
  const pj = profile.props.projeto;
  if (!pj) return;
  if (pj.kind === "multi_select") {
    // Comma-separated input → one option per name, so the "A, B" the read path
    // joins round-trips losslessly (a single option name with a comma is a 400).
    const names = value.split(",").map((s) => s.trim()).filter(Boolean);
    props[pj.name] = { multi_select: names.map((name) => ({ name })) };
  } else {
    props[pj.name] = { select: { name: value } };
  }
}

function applyPrazo(
  profile: TrackerProfile,
  props: Record<string, unknown>,
  start: string,
  end?: string,
): void {
  const pz = profile.props.prazo;
  if (!pz) return;
  const range: { start: string; end?: string } = { start: start.trim() };
  if (end && end.trim()) range.end = end.trim();
  props[pz.name] = { date: range };
}

// --- create payload (pure) -------------------------------------------------------

/** PURE: POST /v1/pages body for a canonical create against this profile.
 *  - tipo='cobrar' without a tipo prop → "Cobrar: " title prefix.
 *  - origem_url without an origem prop → first line of the page-body note.
 *  - status done + concluida_em prop → concluida_em = todayISO. */
export function buildCreatePagePayload(
  profile: TrackerProfile,
  input: CreateTaskInput,
  todayISO: string,
): Record<string, unknown> {
  const p = profile.props;
  const props: Record<string, unknown> = {};

  let title = input.title.trim();
  const tipoCanonical = input.tipo ? canonicalTipoFor(input.tipo) : null;
  if (tipoCanonical === "cobrar" && !p.tipo && !normalize(title).startsWith("cobrar")) {
    title = `Cobrar: ${title}`;
  }
  props[p.title] = titleValue(title);

  if (input.status && input.status.trim()) {
    applyStatus(profile, props, input.status.trim(), todayISO);
  } else if (p.status) {
    // No status given: land the task in the "todo" column instead of an
    // ungrouped (sem status) card on the Kanban. Best-effort — a status-kind
    // base with no todo-like option just leaves it unset, as before.
    try {
      applyStatus(profile, props, "todo", todayISO);
    } catch {
      /* base sem opção todo-like: mantém sem status */
    }
  }
  if (input.prioridade && input.prioridade.trim()) applyPriority(profile, props, input.prioridade.trim());
  if (input.prazo && input.prazo.trim()) applyPrazo(profile, props, input.prazo, input.prazo_fim);
  if (typeof input.tempo_estimado_min === "number" && p.tempo) {
    props[p.tempo.name] = { number: input.tempo_estimado_min };
  }
  if (input.tipo && input.tipo.trim()) applyTipo(profile, props, input.tipo.trim());
  if (input.quem && input.quem.trim() && p.quem) props[p.quem.name] = richTextValue(input.quem.trim());

  let note = input.note?.trim() ?? "";
  if (input.origem_url && input.origem_url.trim()) {
    const url = input.origem_url.trim();
    if (p.origem) {
      props[p.origem.name] = p.origem.kind === "url" ? { url } : richTextValue(url);
    } else {
      // No origem property: keep the provenance as the first line of the note.
      note = note ? `${url}\n${note}` : url;
    }
  }
  if (input.projeto && input.projeto.trim()) applyProjeto(profile, props, input.projeto.trim());

  const payload: Record<string, unknown> = {
    parent: { type: "data_source_id", data_source_id: profile.dataSourceId },
    properties: props,
  };
  if (note) {
    payload.children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: note.slice(0, 2000) } }] },
      },
    ];
  }
  return payload;
}

// --- update payload (pure) -------------------------------------------------------

/** PURE: PATCH /v1/pages/{id} properties for a canonical patch. Only the given
 *  fields are touched; status done also sets concluida_em (when mapped).
 *  prazo_fim is only meaningful together with prazo (a Notion date range needs
 *  its start). nota_append is handled separately (block append, not a prop). */
export function buildUpdatePagePayload(
  profile: TrackerProfile,
  patch: UpdateTaskPatch,
  todayISO: string,
): Record<string, unknown> {
  const p = profile.props;
  const props: Record<string, unknown> = {};

  if (patch.titulo && patch.titulo.trim()) props[p.title] = titleValue(patch.titulo.trim());
  if (patch.status && patch.status.trim()) applyStatus(profile, props, patch.status.trim(), todayISO);
  if (patch.prioridade && patch.prioridade.trim()) applyPriority(profile, props, patch.prioridade.trim());
  if (patch.prazo !== undefined && p.prazo) {
    // Empty string clears the date; otherwise set start (+ optional end).
    if (!patch.prazo.trim()) props[p.prazo.name] = { date: null };
    else applyPrazo(profile, props, patch.prazo, patch.prazo_fim);
  }
  if (typeof patch.tempo_estimado_min === "number" && p.tempo) {
    props[p.tempo.name] = { number: patch.tempo_estimado_min };
  }
  if (patch.tipo && patch.tipo.trim()) applyTipo(profile, props, patch.tipo.trim());
  if (patch.quem && patch.quem.trim() && p.quem) props[p.quem.name] = richTextValue(patch.quem.trim());
  if (patch.projeto && patch.projeto.trim()) applyProjeto(profile, props, patch.projeto.trim());

  return props;
}

// --- network --------------------------------------------------------------------

/** "Today" (concluida_em on done) follows the USER's timezone, not the server
 *  clock: at 00:30Z it is still the previous day in America/Sao_Paulo. */
function localDateStr(d: Date): string {
  return localDateInTz(DEFAULT_TIMEZONE, d);
}

export interface CreatedTask {
  pageId: string;
  url: string | null;
  dataSourceId: string;
  /** Link do board (URL da base de Tarefas) para "abrir no Notion". */
  trackerUrl: string | null;
  /** True when the standard "Tarefas" tracker was created on this first use. */
  created: boolean;
}

/** Create a task in the account's tracker. First use without a tracker
 *  auto-creates the standard "🧠 Zinom → Tarefas" base (same behavior the old
 *  createTaskPage had). 400 responses (cached profile drifted from the real
 *  schema) invalidate the profile and retry once. */
export async function createTask(
  accountId: string,
  input: CreateTaskInput,
  deps: AdapterDeps = {},
): Promise<CreatedTask> {
  if (!input.title || !input.title.trim()) throw new Error("título obrigatório");
  const fetchImpl = deps.fetchImpl ?? fetch;

  let created = false;
  let ctx: TrackerContext;
  try {
    ctx = await loadTrackerProfile(accountId, deps);
  } catch (err) {
    if (!(err instanceof NoTrackerError)) throw err;
    // Write path only: auto-create the standard tracker on first use. Read
    // paths (listTasks) NEVER create.
    const { createTaskTracker } = await import("../portal/task-tracker.js");
    const r = await createTaskTracker(accountId, { fetchImpl });
    created = r.created; // false when an existing "Tarefas" was reused
    invalidateTrackerProfile(accountId);
    ctx = await loadTrackerProfile(accountId, deps);
  }

  const today = localDateStr(deps.now ?? new Date());
  const attempt = (c: TrackerContext) =>
    rawNotionFetch(
      c.token,
      "/v1/pages",
      { method: "POST", body: JSON.stringify(buildCreatePagePayload(c.profile, input, today)) },
      fetchImpl,
    );

  let r = await attempt(ctx);
  if (!r.ok && r.status === 400) {
    invalidateTrackerProfile(accountId);
    ctx = await loadTrackerProfile(accountId, deps);
    r = await attempt(ctx);
  }
  if (!r.ok) throw new Error(rawErrorMessage("/v1/pages", r));
  return {
    pageId: r.data?.id ?? "",
    url: r.data?.url ?? null,
    dataSourceId: ctx.profile.dataSourceId,
    trackerUrl: ctx.profile.url ?? null,
    created,
  };
}

function normalizeId(id: unknown): string {
  return String(id ?? "").replace(/-/g, "").toLowerCase();
}

/** Update a task. SECURITY: fetches the page first and verifies its parent is
 *  the account's tracker data source — any other page id is a 404
 *  (TaskNotFoundError), so a task_id can never reach another base/tenant. */
export async function updateTask(
  accountId: string,
  pageId: string,
  patch: UpdateTaskPatch,
  deps: AdapterDeps = {},
): Promise<Task> {
  if (!pageId || !pageId.trim()) throw new TaskNotFoundError();
  const fetchImpl = deps.fetchImpl ?? fetch;
  let ctx = await loadTrackerProfile(accountId, deps);

  const page = await rawNotionFetch(ctx.token, `/v1/pages/${pageId.trim()}`, { method: "GET" }, fetchImpl);
  // Only a real 404 means "not your task"; a 429/5xx is a transient read
  // failure and must surface as such (mirrors the PATCH error handling below).
  if (page.status === 404) throw new TaskNotFoundError();
  if (!page.ok) throw new Error(rawErrorMessage(`/v1/pages/${pageId}`, page));
  const parentDs = page.data?.parent?.data_source_id;
  if (!parentDs || normalizeId(parentDs) !== normalizeId(ctx.profile.dataSourceId)) {
    throw new TaskNotFoundError();
  }

  const today = localDateStr(deps.now ?? new Date());
  let updatedPage: any = page.data;

  const buildProps = (c: TrackerContext) => buildUpdatePagePayload(c.profile, patch, today);
  let props = buildProps(ctx);
  if (Object.keys(props).length > 0) {
    const attempt = (body: Record<string, unknown>) =>
      rawNotionFetch(
        ctx.token,
        `/v1/pages/${pageId.trim()}`,
        { method: "PATCH", body: JSON.stringify({ properties: body }) },
        fetchImpl,
      );
    let r = await attempt(props);
    if (!r.ok && r.status === 400) {
      invalidateTrackerProfile(accountId);
      ctx = await loadTrackerProfile(accountId, deps);
      props = buildProps(ctx);
      r = await attempt(props);
    }
    if (!r.ok) throw new Error(rawErrorMessage(`/v1/pages/${pageId}`, r));
    updatedPage = r.data;
  }

  if (patch.nota_append && patch.nota_append.trim()) {
    const r = await rawNotionFetch(
      ctx.token,
      `/v1/blocks/${pageId.trim()}/children`,
      {
        method: "PATCH",
        body: JSON.stringify({
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: patch.nota_append.trim().slice(0, 2000) } }],
              },
            },
          ],
        }),
      },
      fetchImpl,
    );
    if (!r.ok) throw new Error(rawErrorMessage(`/v1/blocks/${pageId}/children`, r));
  }

  return pageToTask(ctx.profile, updatedPage);
}
