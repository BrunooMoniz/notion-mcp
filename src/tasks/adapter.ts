// src/tasks/adapter.ts
// 003-tasks-v1 — schema adapter. Resolves the account's task tracker (vault
// `tasks_db` data_source id + a Notion token that can read it) and builds a
// TrackerProfile mapping the CANONICAL task model (model.ts) onto the REAL
// schema — the standard pt-BR template, the owner's English status-type board,
// or any base the user already has. All task reads/writes go through this.
//
// Token resolution: friends use the encrypted vault (account-tokens, the same
// pattern as portal/task-write.ts resolveTokenForDataSource); the OWNER
// ('bruno') reads the .env tokens directly (personal, globalcripto, nora — the
// same variables clients.ts validates) WITHOUT importing clients.ts, because
// that module process.exit()s when tokens are absent and would kill unit tests.
import { warmAccount, getAccountToken } from "../account-tokens.js";
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { getTasksDbId } from "../portal/task-tracker.js";
import { TARGET_DB_TITLE } from "../portal/task-tracker-schema.js";
import {
  normalize,
  canonicalStatusFor,
  canonicalPriorityFor,
  PROP_SYNONYMS,
  STATUS_NAME_PT,
  CANONICAL_FIELDS,
  type CanonicalStatus,
  type CanonicalPriority,
  type CanonicalField,
} from "./model.js";

const NOTION_API = "https://api.notion.com";
const NOTION_VERSION = "2025-09-03"; // keep in sync with clients.ts

/** The owner's Tasks Tracker data_source (workspace 'personal') — formerly
 *  hardcoded in briefing/daily-briefing.ts:31. Now ONLY a safety net used when
 *  the owner has no vault `tasks_db` configured: the 07:00 briefing cron must
 *  not break. Deploy configures the vault via `npm run set-tasks-db`. */
export const OWNER_TASKS_DS_FALLBACK = "30d07ba5-bee8-8040-841b-000b5d0b5d84";

// --- typed errors -------------------------------------------------------------

export class NoNotionError extends Error {
  constructor() {
    super("conecte seu Notion no portal antes de usar tarefas");
    this.name = "NoNotionError";
  }
}

/** The account has Notion but no tasks data source configured (vault tasks_db). */
export class NoTrackerError extends Error {
  constructor() {
    super("nenhuma base de tarefas configurada para esta conta");
    this.name = "NoTrackerError";
  }
}

/** Page not found OR belongs to a different data source (isolation guard). */
export class TaskNotFoundError extends Error {
  constructor() {
    super("tarefa não encontrada na sua base de tarefas (404)");
    this.name = "TaskNotFoundError";
  }
}

/** The vault lookup itself failed (DB down etc) — a TRANSIENT error, distinct
 *  from NoTrackerError: the account may well have a tracker configured, we just
 *  couldn't read the config now. Never falls back to the owner's hardcoded ds. */
export class TrackerLookupError extends Error {
  constructor(cause: string) {
    super(`não consegui ler a configuração da sua base de tarefas agora — tente de novo (${cause})`);
    this.name = "TrackerLookupError";
  }
}

// --- raw Notion fetch (token-explicit; fetchImpl injectable for tests) --------

export interface RawNotionResponse {
  ok: boolean;
  status: number;
  data: any;
}

export async function rawNotionFetch(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<RawNotionResponse> {
  const res = await fetchImpl(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

/** Compact error string from a non-ok raw response (no token, no secrets). */
export function rawErrorMessage(path: string, r: RawNotionResponse): string {
  return `Notion ${path}: HTTP ${r.status} ${r.data?.code ?? ""} ${r.data?.message ?? ""}`.trim();
}

// --- TrackerProfile -----------------------------------------------------------

export interface StatusProp {
  name: string;
  kind: "status" | "select";
  /** canonical → REAL option name in this base (first matching option). */
  map: Partial<Record<CanonicalStatus, string>>;
  /** normalized real option name → canonical (unmatched options = passthrough). */
  reverse: Record<string, CanonicalStatus>;
  /** Real option names, in schema order. */
  options: string[];
}

export interface PriorityProp {
  name: string;
  map: Partial<Record<CanonicalPriority, string>>;
  reverse: Record<string, CanonicalPriority>;
  options: string[];
}

export interface TrackerProfile {
  dataSourceId: string;
  url: string | null;
  title: string;
  props: {
    /** Name of the title property (always present in a Notion data source). */
    title: string;
    status?: StatusProp;
    prioridade?: PriorityProp;
    prazo?: { name: string };
    tempo?: { name: string };
    tipo?: { name: string; options: string[] };
    /** ONLY rich_text (people props are out of scope for v1). */
    quem?: { name: string };
    origem?: { name: string; kind: "url" | "rich_text" };
    projeto?: { name: string; kind: "select" | "multi_select" };
    concluida_em?: { name: string };
    criada_em?: { name: string };
  };
  /** Canonical fields with no matching property in this schema. */
  missing: CanonicalField[];
}

type RawProps = Record<string, any>;

function plainTitle(title: unknown): string {
  if (typeof title === "string") return title.trim();
  if (!Array.isArray(title)) return "";
  return title
    .map((t: any) => t?.plain_text ?? t?.text?.content ?? "")
    .join("")
    .trim();
}

/** Select NAMES that sound like a status column (pass 1 of the claim). */
const STATUS_NAME_RE = /status|situa|estado|stage|etapa/;

/** Selects whose NAME maps to another canonical select field (tipo/prioridade/
 *  projeto) must never be claimed by the status OPTIONS heuristic — e.g. the
 *  template's own "Tipo" (Fazer/Cobrar) matches /fazer/ but is not a status. */
const NON_STATUS_SELECT_NAMES = new Set(
  ["tipo", "prioridade", "projeto"].flatMap((f) => (PROP_SYNONYMS[f] ?? []).map(normalize)),
);

/** Pass 2 of the claim: the select's OPTIONS sound like a status column. */
function hasStatusLikeOptions(def: any): boolean {
  const opts = (def?.select?.options ?? [])
    .map((o: any) => normalize(o?.name ?? ""))
    .join(" ");
  return /fazer|fazendo|feito|done|todo|to do|andamento|conclu|backlog|progress/.test(opts);
}

function optionNames(def: any): Array<{ name: string }> {
  const t = def?.type;
  const opts = t === "status" ? def?.status?.options : def?.[t]?.options;
  return Array.isArray(opts) ? opts.filter((o: any) => o?.name) : [];
}

function buildStatusMaps(options: Array<{ name: string }>): Pick<StatusProp, "map" | "reverse" | "options"> {
  const map: Partial<Record<CanonicalStatus, string>> = {};
  const reverse: Record<string, CanonicalStatus> = {};
  const names: string[] = [];
  for (const o of options) {
    names.push(o.name);
    const c = canonicalStatusFor(o.name);
    if (c) {
      reverse[normalize(o.name)] = c;
      if (!map[c]) map[c] = o.name;
    }
  }
  return { map, reverse, options: names };
}

function buildPriorityMaps(options: Array<{ name: string }>): Pick<PriorityProp, "map" | "reverse" | "options"> {
  const map: Partial<Record<CanonicalPriority, string>> = {};
  const reverse: Record<string, CanonicalPriority> = {};
  const names: string[] = [];
  for (const o of options) {
    names.push(o.name);
    const c = canonicalPriorityFor(o.name);
    if (c) {
      reverse[normalize(o.name)] = c;
      if (!map[c]) map[c] = o.name;
    }
  }
  return { map, reverse, options: names };
}

/** Allowed Notion property types per canonical named field. */
const FIELD_TYPES: Record<string, string[]> = {
  prioridade: ["select"],
  prazo: ["date"],
  tempo: ["number"],
  tipo: ["select"],
  quem: ["rich_text"],
  origem: ["url", "rich_text"],
  projeto: ["select", "multi_select"],
  concluida_em: ["date"],
};

// Match order matters: concluida_em is claimed BEFORE prazo so a "Concluída em"
// date prop is never stolen by prazo's broad "data" synonym.
const FIELD_ORDER = [
  "prioridade",
  "concluida_em",
  "prazo",
  "tempo",
  "tipo",
  "quem",
  "origem",
  "projeto",
] as const;

/** PURE: build a TrackerProfile from a raw data source object (GET
 *  /v1/data_sources/{id} shape). Exported for table-driven unit tests. */
export function buildTrackerProfile(ds: {
  id: string;
  title?: unknown;
  url?: string | null;
  parent?: any;
  properties: RawProps;
}): TrackerProfile {
  const properties = ds.properties ?? {};
  const claimed = new Set<string>();

  // Title prop: the (single) property of type "title".
  let titleName = "Nome";
  for (const [name, def] of Object.entries(properties)) {
    if (def?.type === "title") {
      titleName = name;
      claimed.add(name);
      break;
    }
  }

  const props: TrackerProfile["props"] = { title: titleName };

  // Status: first prop of type `status`; else first status-like select.
  for (const [name, def] of Object.entries(properties)) {
    if (claimed.has(name)) continue;
    if (def?.type === "status") {
      props.status = { name, kind: "status", ...buildStatusMaps(optionNames(def)) };
      claimed.add(name);
      break;
    }
  }
  // Select fallback in two passes: (1) a select whose NAME sounds like status;
  // only when none exists, (2) the options heuristic — which must skip selects
  // named like another canonical field (Tipo "Fazer/Cobrar" matches /fazer/).
  if (!props.status) {
    for (const [name, def] of Object.entries(properties)) {
      if (claimed.has(name)) continue;
      if (def?.type !== "select") continue;
      if (!STATUS_NAME_RE.test(normalize(name))) continue;
      props.status = { name, kind: "select", ...buildStatusMaps(optionNames(def)) };
      claimed.add(name);
      break;
    }
  }
  if (!props.status) {
    for (const [name, def] of Object.entries(properties)) {
      if (claimed.has(name)) continue;
      if (def?.type !== "select") continue;
      if (NON_STATUS_SELECT_NAMES.has(normalize(name))) continue;
      if (!hasStatusLikeOptions(def)) continue;
      props.status = { name, kind: "select", ...buildStatusMaps(optionNames(def)) };
      claimed.add(name);
      break;
    }
  }

  // Named fields via PROP_SYNONYMS: exact-name pass first, then substring pass.
  const findByName = (field: string, exact: boolean): [string, any] | null => {
    const syns = (PROP_SYNONYMS[field] ?? []).map(normalize);
    const types = FIELD_TYPES[field] ?? [];
    for (const [name, def] of Object.entries(properties)) {
      if (claimed.has(name)) continue;
      if (!types.includes(def?.type)) continue;
      const n = normalize(name);
      const hit = exact ? syns.includes(n) : syns.some((s) => n.includes(s));
      if (hit) return [name, def];
    }
    return null;
  };

  const matches = new Map<string, [string, any]>();
  for (const exact of [true, false]) {
    for (const field of FIELD_ORDER) {
      if (matches.has(field)) continue;
      const hit = findByName(field, exact);
      if (hit) {
        matches.set(field, hit);
        claimed.add(hit[0]);
      }
    }
  }

  const prio = matches.get("prioridade");
  if (prio) props.prioridade = { name: prio[0], ...buildPriorityMaps(optionNames(prio[1])) };
  const prazo = matches.get("prazo");
  if (prazo) props.prazo = { name: prazo[0] };
  const tempo = matches.get("tempo");
  if (tempo) props.tempo = { name: tempo[0] };
  const tipo = matches.get("tipo");
  if (tipo) props.tipo = { name: tipo[0], options: optionNames(tipo[1]).map((o) => o.name) };
  const quem = matches.get("quem");
  if (quem) props.quem = { name: quem[0] };
  const origem = matches.get("origem");
  if (origem) props.origem = { name: origem[0], kind: origem[1].type === "url" ? "url" : "rich_text" };
  const projeto = matches.get("projeto");
  if (projeto) {
    props.projeto = { name: projeto[0], kind: projeto[1].type === "multi_select" ? "multi_select" : "select" };
  }
  const concl = matches.get("concluida_em");
  if (concl) props.concluida_em = { name: concl[0] };

  // criada_em: the first created_time prop (no name synonym needed — the type
  // is unambiguous).
  for (const [name, def] of Object.entries(properties)) {
    if (claimed.has(name)) continue;
    if (def?.type === "created_time") {
      props.criada_em = { name };
      claimed.add(name);
      break;
    }
  }

  const missing = CANONICAL_FIELDS.filter((f) => !(props as Record<string, unknown>)[f]);

  // The data source object may not carry a url; derive the parent database's.
  const dbId = ds.parent?.database_id ? String(ds.parent.database_id) : null;
  const url = ds.url ?? (dbId ? `https://www.notion.so/${dbId.replace(/-/g, "")}` : null);

  return {
    dataSourceId: ds.id,
    url,
    title: plainTitle(ds.title),
    props,
    missing,
  };
}

// --- status option resolution (write/filter semantics) -------------------------

/** Resolve a status VALUE (canonical key, synonym, or literal option name) to
 *  the real option name to write in this base. select kind: unmatched canonical
 *  falls back to the pt-BR default name (Notion creates the option); status
 *  kind: options can't be created via API → clear error listing what exists. */
export function resolveStatusOptionName(statusProp: StatusProp, value: string): string {
  // Literal passthrough first: the exact option exists in the base.
  const literal = statusProp.options.find((o) => normalize(o) === normalize(value));
  if (literal) return literal;

  const canonical = canonicalStatusFor(value);
  if (canonical) {
    const mapped = statusProp.map[canonical];
    if (mapped) return mapped;
    if (statusProp.kind === "select") return STATUS_NAME_PT[canonical];
    throw new Error(
      `status "${value}" não existe nesta base; opções disponíveis: ${statusProp.options.join(", ")}`,
    );
  }
  if (statusProp.kind === "select") return value; // Notion creates the option
  throw new Error(
    `status "${value}" não existe nesta base; opções disponíveis: ${statusProp.options.join(", ")}`,
  );
}

// --- token resolution -----------------------------------------------------------

export interface WorkspaceToken {
  workspace: string;
  token: string;
}

/** All Notion tokens for an account, in trial order. Friend: vault PATs/OAuth
 *  per connected workspace. Owner: .env tokens (personal, globalcripto, nora).
 *  task-write.ts and this adapter share this single resolver. */
export async function resolveNotionTokens(accountId: string): Promise<WorkspaceToken[]> {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const order: Array<[string, string | undefined]> = [
      ["personal", process.env.NOTION_PERSONAL_TOKEN],
      ["globalcripto", process.env.NOTION_GLOBALCRIPTO_TOKEN],
      ["nora", process.env.NOTION_NORA_TOKEN],
    ];
    return order
      .filter((e): e is [string, string] => !!e[1])
      .map(([workspace, token]) => ({ workspace, token }));
  }
  const workspaces = await warmAccount(accountId);
  const out: WorkspaceToken[] = [];
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (token) out.push({ workspace: ws, token });
  }
  return out;
}

// --- loadTrackerProfile (cache TTL 5 min + invalidate) --------------------------

export interface TrackerContext {
  profile: TrackerProfile;
  token: string;
  workspace: string;
}

/** Injectable seams for tests (and for callers that already hold a fetch). */
export interface AdapterDeps {
  fetchImpl?: typeof fetch;
  getTasksDbIdImpl?: (accountId: string) => Promise<string | null>;
  resolveTokensImpl?: (accountId: string) => Promise<WorkspaceToken[]>;
  now?: Date;
}

const PROFILE_TTL_MS = 5 * 60_000;
const profileCache = new Map<string, { ctx: TrackerContext; expiresAt: number }>();

export function invalidateTrackerProfile(accountId: string): void {
  profileCache.delete(accountId);
}

/** Test seam: drop every cached profile. */
export function __clearTrackerProfileCache(): void {
  profileCache.clear();
}

async function defaultGetTasksDbId(accountId: string): Promise<string | null> {
  // No swallowing here: a vault FAILURE must not look like "no tracker" (that
  // would silently route the owner to the hardcoded fallback and a friend to
  // no_tracker). loadTrackerProfile wraps it in TrackerLookupError.
  return getTasksDbId(accountId);
}

/** Resolve the tracker data source + a token that can read it, and build the
 *  profile. Cached per account for 5 min; call invalidateTrackerProfile() when
 *  a write fails with a 400 (schema drift) and retry once. */
export async function loadTrackerProfile(
  accountId: string,
  deps: AdapterDeps = {},
): Promise<TrackerContext> {
  const nowMs = (deps.now ?? new Date()).getTime();
  const hit = profileCache.get(accountId);
  if (hit && hit.expiresAt > nowMs) return hit.ctx;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const getId = deps.getTasksDbIdImpl ?? defaultGetTasksDbId;
  const resolveTokens = deps.resolveTokensImpl ?? resolveNotionTokens;

  const tokens = await resolveTokens(accountId);
  if (tokens.length === 0) throw new NoNotionError();

  let dsId: string | null;
  try {
    dsId = await getId(accountId);
  } catch (err: any) {
    // Vault unreachable ≠ no tracker. Owner fallback only applies when the
    // vault genuinely answered null.
    console.warn(`[tasks] getTasksDbId(${accountId}) failed: ${err?.message ?? err}`);
    throw new TrackerLookupError(err?.message ?? String(err));
  }
  if (!dsId) {
    if (accountId === DEFAULT_ACCOUNT_ID) dsId = OWNER_TASKS_DS_FALLBACK;
    else throw new NoTrackerError();
  }

  const transientStatus = (s: number) => s === 429 || s >= 500;
  let lastErr = "";
  let lastTransient = false;
  for (const { workspace, token } of tokens) {
    let r = await rawNotionFetch(token, `/v1/data_sources/${dsId}`, { method: "GET" }, fetchImpl);
    if (!r.ok && transientStatus(r.status)) {
      // One retry per token: rate limit / transient Notion 5xx.
      r = await rawNotionFetch(token, `/v1/data_sources/${dsId}`, { method: "GET" }, fetchImpl);
    }
    if (r.ok) {
      const profile = buildTrackerProfile({ ...r.data, id: dsId });
      const ctx: TrackerContext = { profile, token, workspace };
      profileCache.set(accountId, { ctx, expiresAt: nowMs + PROFILE_TTL_MS });
      return ctx;
    }
    lastErr = `HTTP ${r.status} ${r.data?.code ?? ""} ${r.data?.message ?? ""}`.trim();
    lastTransient = transientStatus(r.status);
  }
  if (lastTransient) {
    // Clearly transient wording — distinct from no_tracker, so callers/AI know
    // a retry can fix it (nothing is misconfigured).
    throw new Error(`não consegui ler sua base de tarefas agora — tente de novo (${lastErr})`);
  }
  throw new Error(`não consegui ler a base de tarefas (${dsId}): ${lastErr}`);
}

// --- /portal/tasks/info shape ----------------------------------------------------

export interface TasksInfo {
  configured: boolean;
  title: string | null;
  url: string | null;
  mapped: string[];
  missing: string[];
  is_standard: boolean;
}

/** Info for the portal: what the adapter mapped/missed on the configured base.
 *  Not configured (or Notion disconnected) → configured:false, never throws for
 *  those two expected states. */
export async function getTasksInfo(accountId: string, deps: AdapterDeps = {}): Promise<TasksInfo> {
  try {
    const { profile } = await loadTrackerProfile(accountId, deps);
    return {
      configured: true,
      title: profile.title || null,
      url: profile.url,
      mapped: CANONICAL_FIELDS.filter((f) => !profile.missing.includes(f)),
      missing: [...profile.missing],
      is_standard: normalize(profile.title) === normalize(TARGET_DB_TITLE),
    };
  } catch (err) {
    if (err instanceof NoTrackerError || err instanceof NoNotionError) {
      return { configured: false, title: null, url: null, mapped: [], missing: [], is_standard: false };
    }
    throw err;
  }
}
