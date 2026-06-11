// src/tasks/model.ts
// 003-tasks-v1 — canonical task model + synonym tables. The Zinom must work
// with ANY Notion task base (the standard pt-BR template, the owner's English
// status-type board, or an arbitrary user base), so reads/writes go through a
// canonical vocabulary that the adapter maps to the real schema.
// PURE module: no network, no storage — 100% unit-testable.

export type CanonicalStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "canceled";

export type CanonicalPriority = "urgente" | "alta" | "media" | "baixa";

export type TaskTipo = "fazer" | "cobrar";

/** Canonical Task shape returned by listTasks / accepted (partially) by writes.
 *  `status` may carry a literal option name (passthrough) when the real base has
 *  an option no synonym covers — the AI can still address it by name. */
export interface Task {
  id: string;
  url: string | null;
  title: string;
  status: CanonicalStatus | string;
  prioridade?: CanonicalPriority | string;
  prazo?: string; // ISO date or datetime (start)
  prazo_fim?: string;
  tempo_estimado_min?: number;
  tipo?: TaskTipo | string;
  quem?: string;
  origem_url?: string;
  projeto?: string;
  criada_em?: string;
  concluida_em?: string;
}

/** Accent-insensitive lowercase normalization (same behavior as the existing
 *  normalize() in portal/task-tracker-schema.ts; duplicated here so the pure
 *  model has zero imports). Collapses inner whitespace too. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// --- synonym tables (all keys/values compared via normalize()) ---------------

export const STATUS_SYNONYMS: Record<CanonicalStatus, string[]> = {
  backlog: ["backlog"],
  todo: ["a fazer", "to-do", "todo", "fazer", "not started", "para fazer"],
  in_progress: ["fazendo", "em andamento", "in progress", "doing", "em progresso", "in_progress"],
  blocked: ["bloqueada", "bloqueado", "blocked", "travada"],
  done: ["feito", "feita", "concluida", "concluido", "done", "complete", "completed"],
  canceled: ["cancelada", "cancelado", "canceled", "cancelled"],
};

export const PRIORITY_SYNONYMS: Record<CanonicalPriority, string[]> = {
  urgente: ["urgente", "ultra", "urgent", "p0", "critica"],
  alta: ["alta", "high", "p1"],
  media: ["media", "medium", "p2", "normal"],
  baixa: ["baixa", "low", "p3"],
};

/** Property-NAME synonyms per canonical field (used by the adapter to find the
 *  real property in an arbitrary schema). Order within each list matters only
 *  for readability; matching is exact-first then substring. */
export const PROP_SYNONYMS: Record<string, string[]> = {
  prazo: ["prazo", "due", "due date", "data limite", "deadline", "entrega", "vencimento", "data"],
  tempo: ["tempo estimado", "estimate", "estimativa", "esforco", "effort", "duracao", "min"],
  tipo: ["tipo", "type"],
  quem: ["quem", "responsavel", "owner", "cobrar de"],
  origem: ["origem", "fonte", "source", "link"],
  projeto: ["projeto", "frente", "area", "project"],
  concluida_em: ["concluida em", "concluido em", "completed", "done at", "finalizada em"],
  prioridade: ["prioridade", "priority", "prio"],
};

// --- reverse lookups ----------------------------------------------------------

const statusReverse = new Map<string, CanonicalStatus>();
for (const [canon, syns] of Object.entries(STATUS_SYNONYMS) as [CanonicalStatus, string[]][]) {
  statusReverse.set(normalize(canon), canon);
  for (const s of syns) statusReverse.set(normalize(s), canon);
}

const priorityReverse = new Map<string, CanonicalPriority>();
for (const [canon, syns] of Object.entries(PRIORITY_SYNONYMS) as [CanonicalPriority, string[]][]) {
  priorityReverse.set(normalize(canon), canon);
  for (const s of syns) priorityReverse.set(normalize(s), canon);
}

/** Canonical status for a status/option name (synonym table), or null. */
export function canonicalStatusFor(name: string): CanonicalStatus | null {
  return statusReverse.get(normalize(name)) ?? null;
}

/** Canonical priority for an option name, or null. */
export function canonicalPriorityFor(name: string): CanonicalPriority | null {
  return priorityReverse.get(normalize(name)) ?? null;
}

// --- canonical → pt-BR default option names (write fallback for select props) -

export const STATUS_NAME_PT: Record<CanonicalStatus, string> = {
  backlog: "Backlog",
  todo: "A fazer",
  in_progress: "Em andamento",
  blocked: "Bloqueada",
  done: "Concluída",
  canceled: "Cancelada",
};

export const PRIORITY_NAME_PT: Record<CanonicalPriority, string> = {
  urgente: "Urgente",
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const TIPO_NAME_PT: Record<TaskTipo, string> = {
  fazer: "Fazer",
  cobrar: "Cobrar",
};

/** Canonical tipo for an option/input ("Fazer"/"cobrar"/...), or null. */
export function canonicalTipoFor(name: string): TaskTipo | null {
  const n = normalize(name);
  if (n === "fazer") return "fazer";
  if (n === "cobrar") return "cobrar";
  return null;
}

/** The canonical (non-title) fields a tracker schema can map. Order is the
 *  display order used by /portal/tasks/info (mapped/missing lists). */
export const CANONICAL_FIELDS = [
  "status",
  "prioridade",
  "prazo",
  "tempo",
  "tipo",
  "quem",
  "origem",
  "projeto",
  "criada_em",
  "concluida_em",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

// --- ordering helpers ----------------------------------------------------------

/** Board/group order for open statuses. */
export const STATUS_ORDER: CanonicalStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "canceled",
];

export const OPEN_STATUSES: CanonicalStatus[] = ["backlog", "todo", "in_progress", "blocked"];

/** Lower = more urgent. Unknown priority sorts last. */
export const PRIORITY_RANK: Record<CanonicalPriority, number> = {
  urgente: 0,
  alta: 1,
  media: 2,
  baixa: 3,
};

export function priorityRank(p: string | undefined): number {
  if (!p) return 9;
  const c = canonicalPriorityFor(p);
  return c ? PRIORITY_RANK[c] : 9;
}

export function isClosedStatus(status: string | undefined): boolean {
  if (!status) return false;
  const c = canonicalStatusFor(status);
  return c === "done" || c === "canceled";
}
