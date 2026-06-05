// src/rag/__tests__/web-source.test.ts
// F2.2: pure-helper + injected-fetch tests for the web connector. Runs WITHOUT
// any DB or API key — htmlToText/extractTitle/normalizeWebId are pure, and
// fetchWebDocument takes an injected fetchImpl stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlToText,
  extractTitle,
  normalizeWebId,
  fetchWebDocument,
} from "../sources/web-source.js";

// --- htmlToText -------------------------------------------------------------

test("htmlToText strips script/style/noscript blocks and their contents", () => {
  const html =
    "<p>keep</p><script>var x = 1; // drop</script><style>.a{color:red}</style><noscript>nope</noscript>";
  const out = htmlToText(html);
  assert.ok(out.includes("keep"));
  assert.ok(!out.includes("var x"));
  assert.ok(!out.includes("color:red"));
  assert.ok(!out.includes("nope"));
});

test("htmlToText turns block tags and <br> into newlines", () => {
  const html = "<p>one</p><p>two</p><div>three</div><br>four<li>item</li>";
  const out = htmlToText(html);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, ["one", "two", "three", "four", "item"]);
});

test("htmlToText decodes common + numeric entities", () => {
  const html = "<p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;a&#39; x&nbsp;y &mdash; &#65;</p>";
  const out = htmlToText(html);
  assert.ok(out.includes("A & B"));
  assert.ok(out.includes("<tag>"));
  assert.ok(out.includes('"q"'));
  assert.ok(out.includes("'a'"));
  assert.ok(out.includes("x y"));
  assert.ok(out.includes("—"));
  assert.ok(out.includes("A")); // &#65; -> A
});

test("htmlToText strips comments and collapses excess whitespace/newlines", () => {
  const html = "<p>a</p><!-- a long comment -->\n\n\n\n<p>b</p>     <p>c   d</p>";
  const out = htmlToText(html);
  assert.ok(!out.includes("comment"));
  assert.ok(!/\n{3,}/.test(out)); // never 3+ newlines in a row
  assert.ok(out.includes("c d")); // runs of spaces collapsed
});

// --- extractTitle -----------------------------------------------------------

test("extractTitle prefers og:title over <title>", () => {
  const html =
    '<head><title>Doc Title</title><meta property="og:title" content="OG Title"></head>';
  assert.equal(extractTitle(html), "OG Title");
});

test("extractTitle falls back to <title> when no og:title", () => {
  const html = "<head><title>Just Title</title></head>";
  assert.equal(extractTitle(html), "Just Title");
});

test("extractTitle decodes entities in the title", () => {
  const html = "<head><title>A &amp; B</title></head>";
  assert.equal(extractTitle(html), "A & B");
});

test("extractTitle returns null when neither present", () => {
  assert.equal(extractTitle("<head></head>"), null);
});

// --- normalizeWebId ---------------------------------------------------------

test("normalizeWebId lowercases host and strips fragment", () => {
  assert.equal(
    normalizeWebId("https://Example.COM/Path#section"),
    "https://example.com/Path",
  );
});

test("normalizeWebId strips a trailing slash but keeps the query", () => {
  assert.equal(normalizeWebId("https://example.com/a/b/"), "https://example.com/a/b");
  assert.equal(
    normalizeWebId("https://example.com/a/?q=1"),
    "https://example.com/a?q=1",
  );
});

test("normalizeWebId is stable: same input -> same output", () => {
  const a = normalizeWebId("https://Example.com/x/#frag");
  const b = normalizeWebId("https://example.com/x/");
  assert.equal(a, b);
  assert.equal(a, "https://example.com/x");
});

// --- fetchWebDocument (injected fetch) --------------------------------------

function stubFetch(status: number, html: string): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => html,
    }) as unknown as Response) as unknown as typeof fetch;
}

test("fetchWebDocument builds the IndexableDocument shape from canned HTML", async () => {
  const html =
    '<html><head><meta property="og:title" content="My Article"></head><body><p>Hello world body.</p></body></html>';
  const doc = await fetchWebDocument("https://example.com/post/", {
    workspace: "personal",
    fetchImpl: stubFetch(200, html),
  });

  assert.equal(doc.source_type, "web");
  assert.equal(doc.source_id, "https://example.com/post");
  assert.equal(doc.parent_url, "https://example.com/post/");
  assert.equal(doc.workspace, "personal");
  assert.equal(doc.db_name, null);
  // title appears in both the text and metadata
  assert.ok(doc.text.startsWith("My Article"));
  assert.ok(doc.text.includes("Hello world body."));
  assert.equal(doc.metadata.title, "My Article");
  assert.equal(doc.metadata.url, "https://example.com/post/");
  assert.ok(typeof doc.metadata.fetched_at === "string");
  assert.ok(doc.source_updated instanceof Date);
});

test("fetchWebDocument falls back to body-only text when no title", async () => {
  const html = "<body><p>Just a body.</p></body>";
  const doc = await fetchWebDocument("https://example.com/x", {
    workspace: null,
    fetchImpl: stubFetch(200, html),
  });
  assert.equal(doc.metadata.title, null);
  assert.equal(doc.text.trim(), "Just a body.");
});

test("fetchWebDocument throws a clear error on non-2xx", async () => {
  await assert.rejects(
    () =>
      fetchWebDocument("https://example.com/404", {
        workspace: "personal",
        fetchImpl: stubFetch(404, ""),
      }),
    /HTTP 404/,
  );
});
