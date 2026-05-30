// src/classifier/validate.ts
// F.4.5 — pure post-processing that validates an LLM ClassificationResult
// against the closed unions declared in ./types.ts and DROPS any hallucinated
// frente/tipo/categoria value (sets it to undefined). A dropped value is never
// written to a Notion select, so the LLM can never invent a new select option.
//
// This is a pure function: no LLM call, no Notion call. It is wired into
// notion-classifier.ts before properties are written, and the runtime arrays
// here are the single source of truth for the allowed select values.
import type { ClassificationResult, Frente, ReuniaoTipo, InsightCategoria } from "./types.js";

// Runtime arrays of the allowed select values. Declared `as const` and asserted
// to be exactly the union types from types.ts (the `satisfies` below fails to
// compile if these drift out of sync with the declared unions).
const FRENTE_VALUES = ["Global Cripto", "Nora Finance", "Pessoal", "Conteudo"] as const;
const TIPO_VALUES = [
  "1:1",
  "Time interno",
  "Cliente",
  "Parceiro",
  "Juridico",
  "Investidor",
  "Pessoal",
  "Outro",
] as const;
const CATEGORIA_VALUES = [
  "Estrategia",
  "Regulacao",
  "Produto",
  "Mercado",
  "Pessoas",
  "Operacional",
  "Pessoal",
] as const;

// Compile-time guard: each runtime value must be assignable to its union type.
// If types.ts changes a union, this stops compiling until the arrays match.
const _frenteCheck: readonly Frente[] = FRENTE_VALUES;
const _tipoCheck: readonly ReuniaoTipo[] = TIPO_VALUES;
const _categoriaCheck: readonly InsightCategoria[] = CATEGORIA_VALUES;
void _frenteCheck;
void _tipoCheck;
void _categoriaCheck;

export interface AllowedValues {
  frente: readonly string[];
  tipo: readonly string[];
  categoria: readonly string[];
}

/** The real allowed values, derived from the unions in types.ts. */
export const ALLOWED_VALUES: AllowedValues = {
  frente: FRENTE_VALUES,
  tipo: TIPO_VALUES,
  categoria: CATEGORIA_VALUES,
};

/**
 * Returns the value if it is in the allowed set, otherwise undefined.
 * Trims whitespace before comparing; null/undefined become undefined.
 */
function keepIfAllowed(value: string | null | undefined, allowed: readonly string[]): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return allowed.includes(trimmed) ? trimmed : undefined;
}

/**
 * Validates a ClassificationResult against the allowed unions, dropping any
 * out-of-set frente/tipo/categoria (sets it to undefined). pessoas/organizacoes
 * pass through untouched. Pure — no side effects.
 */
export function validateClassification(
  result: Partial<ClassificationResult> & { pessoas?: string[]; organizacoes?: string[] },
  allowed: AllowedValues = ALLOWED_VALUES,
): {
  frente: string | undefined;
  tipo: string | undefined;
  categoria: string | undefined;
  pessoas: string[];
  organizacoes: string[];
} {
  return {
    frente: keepIfAllowed(result.frente, allowed.frente),
    tipo: keepIfAllowed(result.tipo, allowed.tipo),
    categoria: keepIfAllowed(result.categoria, allowed.categoria),
    pessoas: Array.isArray(result.pessoas) ? result.pessoas : [],
    organizacoes: Array.isArray(result.organizacoes) ? result.organizacoes : [],
  };
}
