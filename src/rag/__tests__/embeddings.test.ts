// src/rag/__tests__/embeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashText, batchEmbed } from "../embeddings.js";

test("hashText returns deterministic sha256 hex", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("world"));
  assert.equal(hashText("hello").length, 64);
});

test("batchEmbed returns vectors of length 1024 per input", async () => {
  // Skip if no API key (CI/dev without secrets)
  if (!process.env.VOYAGE_API_KEY) {
    console.log("skipping: no VOYAGE_API_KEY");
    return;
  }
  const out = await batchEmbed(["a curta", "outra frase em portugues"], { useCache: false });
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 1024);
  assert.equal(out[1].length, 1024);
});
