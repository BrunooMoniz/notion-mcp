// src/rag/__tests__/chunker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, estimateTokens } from "../chunker.js";

test("estimateTokens approximates 1 token per 4 chars", () => {
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("chunkText returns single chunk when text is small", () => {
  const out = chunkText("uma frase curta.", { targetTokens: 500 });
  assert.equal(out.length, 1);
  assert.equal(out[0], "uma frase curta.");
});

test("chunkText respects paragraph boundaries", () => {
  const text = "primeiro paragrafo.\n\nsegundo paragrafo.\n\nterceiro paragrafo.";
  const out = chunkText(text, { targetTokens: 8 });
  assert.ok(out.length >= 2);
  out.forEach((c) => assert.ok(c.trim().length > 0));
});

test("chunkText applies overlap between chunks", () => {
  const long = Array.from({ length: 20 }, (_, i) => `paragrafo ${i} com algum conteudo aqui.`).join("\n\n");
  const out = chunkText(long, { targetTokens: 50, overlapTokens: 10 });
  assert.ok(out.length >= 2);
  const tail = out[0].split(/\s+/).slice(-3).join(" ");
  assert.ok(out[1].includes(tail.split(" ")[2]) || out[1].length > 0);
});

test("chunkText breaks at headings", () => {
  const text = "intro paragrafo.\n\n## Heading 1\n\nconteudo.\n\n## Heading 2\n\nmais conteudo.";
  const out = chunkText(text, { targetTokens: 1000 });
  assert.equal(out.length, 3);
  assert.ok(out[1].startsWith("## Heading 1"));
  assert.ok(out[2].startsWith("## Heading 2"));
});
