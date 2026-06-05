// src/rag/facts.ts
// F2.3 — pure parsing/normalization for the temporal-facts extractor.
//
// This module is FULLY UNIT-TESTABLE: it has NO DB access and NO LLM/SDK calls.
// It owns the Fact shape, the (robust) parsing of the LLM's JSON output, the
// per-item normalization/coercion, and the prompt builder. The LLM call itself
// lives in facts-extractor.ts; the DB layer lives in facts-storage.ts.

/**
 * A durable temporal fact: subject-predicate-object plus an optional validity
 * window and provenance. Dates are ISO `YYYY-MM-DD` strings (or null). Mirrors
 * the columns of the `brain_facts` table (0004_brain_facts.sql).
 */
export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  workspace: string | null;
  source_id: string | null;
  source_type: string | null;
  confidence: number | null;
  valid_from: string | null; // ISO YYYY-MM-DD or null
  valid_to: string | null; // ISO YYYY-MM-DD or null (null = still true)
  metadata?: Record<string, unknown>;
}

/** Context threaded into normalization to fill provenance fields. */
export interface FactContext {
  workspace: string | null;
  source_id: string | null;
  source_type: string | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trim a candidate to a non-empty string, else return null. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    if (typeof value === "number" || typeof value === "boolean") {
      const s = String(value).trim();
      return s.length ? s : null;
    }
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Keep a REAL ISO `YYYY-MM-DD` date, else null. The regex only checks the shape;
 * impossible dates like `2026-13-45` or `2026-02-30` pass the regex but would
 * make Postgres throw (silently dropping the whole batch), so we also validate
 * the components round-trip through a real Date (C6).
 */
function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map((n) => parseInt(n, 10));
  // Construct in UTC and require every component to round-trip — this rejects
  // overflow normalization (e.g. month 13 -> next year, day 30 of Feb -> March).
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Clamp a numeric confidence to [0,1]; non-numbers → null. An empty or
 * whitespace-only string is "unknown" → null, NOT 0 — `Number("")` and
 * `Number("   ")` are both 0, which would silently fabricate a confidence (C5).
 */
function clampConfidence(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    if (value.trim() === "") return null; // empty/whitespace = unknown, not 0
    n = Number(value);
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Coerce/trim one raw item into a Fact, filling provenance from `ctx`. Returns
 * null if subject/predicate/object are not all present (non-empty). Confidence
 * is clamped to [0,1]; dates that aren't ISO `YYYY-MM-DD` become null. Pure.
 */
export function normalizeFact(input: unknown, ctx: FactContext): Fact | null {
  if (input === null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;

  const subject = nonEmptyString(o.subject);
  const predicate = nonEmptyString(o.predicate);
  const object = nonEmptyString(o.object);
  if (!subject || !predicate || !object) return null;

  const fact: Fact = {
    subject,
    predicate,
    object,
    workspace: ctx.workspace ?? null,
    source_id: ctx.source_id ?? null,
    source_type: ctx.source_type ?? null,
    confidence: clampConfidence(o.confidence),
    valid_from: isoDateOrNull(o.valid_from),
    valid_to: isoDateOrNull(o.valid_to),
  };

  if (o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata)) {
    fact.metadata = o.metadata as Record<string, unknown>;
  }

  return fact;
}

/**
 * Extract the first top-level JSON array from a raw LLM response, tolerating
 * code fences (```json …```) and surrounding prose. Returns the substring from
 * the first `[` to its matching `]`, or null if none is found.
 */
function extractJsonArray(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("[");
  if (start === -1) return null;
  // Walk to the matching close bracket, respecting string literals so a `]`
  // inside a quoted value doesn't end the array early.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the LLM's JSON output robustly into Fact items. Tolerates code fences /
 * surrounding prose by extracting the first JSON array. Returns [] on anything
 * unparseable. Each item must have non-empty subject/predicate/object or it is
 * dropped. NOTE: this preserves whatever provenance/dates the model emitted —
 * use normalizeFact() to fill provenance and coerce/validate fields.
 */
export function parseFactsResponse(raw: string): Fact[] {
  const slice = extractJsonArray(raw);
  if (!slice) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Fact[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const subject = nonEmptyString(o.subject);
    const predicate = nonEmptyString(o.predicate);
    const object = nonEmptyString(o.object);
    if (!subject || !predicate || !object) continue;

    const fact: Fact = {
      subject,
      predicate,
      object,
      workspace: nonEmptyString(o.workspace),
      source_id: nonEmptyString(o.source_id),
      source_type: nonEmptyString(o.source_type),
      confidence: clampConfidence(o.confidence),
      valid_from: isoDateOrNull(o.valid_from),
      valid_to: isoDateOrNull(o.valid_to),
    };
    if (o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata)) {
      fact.metadata = o.metadata as Record<string, unknown>;
    }
    out.push(fact);
  }
  return out;
}

/**
 * Build the fact-extraction prompt for a passage. Bilingual PT-BR/EN: asks the
 * model to extract DURABLE subject-predicate-object facts with optional validity
 * dates, returning a STRICT JSON array, and explicitly to return `[]` when there
 * are no durable facts. Pure (no LLM call).
 */
export function buildFactExtractionPrompt(text: string, ctx: FactContext): string {
  const ws = ctx.workspace ? ` (workspace: ${ctx.workspace})` : "";
  return [
    "Extraia FATOS DURÁVEIS (que tendem a permanecer verdadeiros ao longo do tempo) do",
    `texto abaixo${ws}, no formato sujeito-predicado-objeto (subject-predicate-object).`,
    "Extract DURABLE facts (those that tend to stay true over time) as subject-predicate-object triples.",
    "",
    "Cada fato é um objeto JSON com os campos / Each fact is a JSON object with the fields:",
    '  "subject"    — a entidade (pessoa, empresa, produto). string não-vazia / non-empty string',
    '  "predicate"  — a relação (ex: "trabalha em", "é sócio de", "usa", "role"). string não-vazia',
    '  "object"     — o valor/alvo da relação. string não-vazia / non-empty string',
    '  "valid_from" — data ISO "YYYY-MM-DD" em que o fato passou a valer, ou null',
    '  "valid_to"   — data ISO "YYYY-MM-DD" em que deixou de valer, ou null (null = ainda válido)',
    '  "confidence" — número de 0 a 1 indicando confiança / number 0..1',
    "",
    "Regras / Rules:",
    "- Apenas fatos DURÁVEIS — ignore eventos pontuais, opiniões e tarefas.",
    "  Only DURABLE facts — skip one-off events, opinions, and to-dos.",
    "- Responda APENAS com um array JSON estrito. Sem markdown, sem texto explicativo.",
    "  Respond ONLY with a strict JSON array. No markdown, no prose.",
    "- Se NÃO houver fatos duráveis, retorne []. If there are no durable facts, return [].",
    "",
    "---",
    text,
    "---",
  ].join("\n");
}
