// src/rag/__tests__/validate.test.ts
// Lives in __tests__ so the `npm test` glob (src/rag/__tests__/*.test.ts) picks
// it up; the unit under test lives at src/classifier/validate.ts.
//
// F.4.5 — classifier enum validation: validateClassification() drops any
// frente/tipo/categoria value that is not in the corresponding union from
// classifier/types.ts. Dropped values become undefined and are therefore never
// written to a Notion select (no hallucinated option is created).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateClassification, ALLOWED_VALUES } from "../../classifier/validate.js";

// A generic allowed-set fixture (mirrors the union-of-strings shape).
const ALLOWED = {
  frente: ["nora", "globalcripto", "pessoal"],
  tipo: ["reuniao", "insight", "decisao"],
  categoria: ["produto", "regulatorio", "comercial"],
};

test("keeps in-set values", () => {
  const out = validateClassification(
    { frente: "nora", tipo: "reuniao", categoria: "produto", pessoas: ["X"], organizacoes: [] },
    ALLOWED,
  );
  assert.equal(out.frente, "nora");
  assert.equal(out.tipo, "reuniao");
  assert.equal(out.categoria, "produto");
});

test("drops hallucinated value (sets undefined, never a new option)", () => {
  const out = validateClassification(
    { frente: "marte", tipo: "reuniao", categoria: "produto", pessoas: [], organizacoes: [] },
    ALLOWED,
  );
  assert.equal(out.frente, undefined); // dropped, not written to Notion
  assert.equal(out.tipo, "reuniao");
  assert.equal(out.categoria, "produto");
});

test("drops hallucinated tipo and categoria independently", () => {
  const out = validateClassification(
    { frente: "nora", tipo: "happy-hour", categoria: "fofoca", pessoas: [], organizacoes: [] },
    ALLOWED,
  );
  assert.equal(out.frente, "nora");
  assert.equal(out.tipo, undefined);
  assert.equal(out.categoria, undefined);
});

test("null / undefined values pass through as undefined (nothing to validate)", () => {
  const out = validateClassification(
    { frente: null, tipo: undefined, categoria: null, pessoas: [], organizacoes: [] },
    ALLOWED,
  );
  assert.equal(out.frente, undefined);
  assert.equal(out.tipo, undefined);
  assert.equal(out.categoria, undefined);
});

test("preserves pessoas/organizacoes untouched", () => {
  const out = validateClassification(
    { frente: "marte", tipo: "reuniao", categoria: "produto", pessoas: ["Jean", "Luigi"], organizacoes: ["Parfin"] },
    ALLOWED,
  );
  assert.deepEqual(out.pessoas, ["Jean", "Luigi"]);
  assert.deepEqual(out.organizacoes, ["Parfin"]);
});

test("ALLOWED_VALUES exposes the real unions from classifier/types.ts", () => {
  // Real frentes from types.ts
  assert.ok(ALLOWED_VALUES.frente.includes("Global Cripto"));
  assert.ok(ALLOWED_VALUES.frente.includes("Nora Finance"));
  assert.ok(ALLOWED_VALUES.frente.includes("Pessoal"));
  assert.ok(ALLOWED_VALUES.frente.includes("Conteudo"));
  // Real reuniao tipos
  assert.ok(ALLOWED_VALUES.tipo.includes("1:1"));
  assert.ok(ALLOWED_VALUES.tipo.includes("Investidor"));
  // Real insight categorias
  assert.ok(ALLOWED_VALUES.categoria.includes("Regulacao"));
  assert.ok(ALLOWED_VALUES.categoria.includes("Operacional"));
});

test("validateClassification against the real ALLOWED_VALUES drops out-of-union frente", () => {
  const out = validateClassification(
    { frente: "Marte SA", tipo: "1:1", categoria: "Regulacao", pessoas: [], organizacoes: [] },
    ALLOWED_VALUES,
  );
  assert.equal(out.frente, undefined); // "Marte SA" is not a real Frente
  assert.equal(out.tipo, "1:1");
  assert.equal(out.categoria, "Regulacao");
});
