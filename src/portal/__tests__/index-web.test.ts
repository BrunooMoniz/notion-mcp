// src/portal/__tests__/index-web.test.ts
// POST /portal/index-web input validation — only absolute http(s) URLs pass
// (the deep SSRF/private-host guard lives in web-source.ts and has its own
// tests; this is the cheap first gate the route applies before any work).
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHttpUrl } from "../index-web.js";

test("parseHttpUrl accepts http and https URLs (trimmed, normalized)", () => {
  assert.equal(parseHttpUrl("https://example.com/artigo"), "https://example.com/artigo");
  assert.equal(parseHttpUrl("http://example.com"), "http://example.com/");
  assert.equal(parseHttpUrl("  https://example.com/a?b=1  "), "https://example.com/a?b=1");
});

test("parseHttpUrl rejects non-http(s) schemes", () => {
  assert.equal(parseHttpUrl("ftp://example.com/file"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("file:///etc/passwd"), null);
  assert.equal(parseHttpUrl("data:text/html,<b>x</b>"), null);
});

test("parseHttpUrl rejects garbage, relative and empty input", () => {
  assert.equal(parseHttpUrl("not a url"), null);
  assert.equal(parseHttpUrl("/relative/path"), null);
  assert.equal(parseHttpUrl("example.com"), null); // no scheme
  assert.equal(parseHttpUrl(""), null);
  assert.equal(parseHttpUrl("   "), null);
});

test("parseHttpUrl rejects non-string input", () => {
  assert.equal(parseHttpUrl(undefined), null);
  assert.equal(parseHttpUrl(null), null);
  assert.equal(parseHttpUrl(42), null);
  assert.equal(parseHttpUrl({ url: "https://x.com" }), null);
});
