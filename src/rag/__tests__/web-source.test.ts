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
  isBlockedHost,
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

test("htmlToText keeps a bare '<' in prose (does not strip to next '>') (C1)", () => {
  // The naive /<[^>]+>/ stripper deletes everything between a literal '<' and
  // the next '>'. Real tags must still be stripped, but prose like "a < 5" must
  // survive intact (including the break between paragraphs).
  const out = htmlToText("<p>a < 5</p><p>next</p>");
  assert.ok(out.includes("a < 5"), `expected "a < 5" in: ${JSON.stringify(out)}`);
  assert.ok(out.includes("next"));
});

test("htmlToText keeps math-like comparisons in prose (C1)", () => {
  const out = htmlToText("<p>3 < 5 and 5 > 3</p>");
  assert.ok(out.includes("3 < 5 and 5 > 3"), JSON.stringify(out));
});

test("htmlToText keeps 'a < b > c' while still stripping real tags (C1)", () => {
  const out = htmlToText("<div class=x>a < b > c</div>");
  assert.ok(out.includes("a < b > c"), JSON.stringify(out));
  assert.ok(!out.includes("class=x"));
  assert.ok(!out.includes("div"));
});

test("htmlToText strips normal tags including attributes and self-closing (C1)", () => {
  const out = htmlToText('<p>x</p><br/><div class="y" id=z>w</div>');
  assert.ok(!out.includes("class"));
  assert.ok(!out.includes("<br"));
  assert.ok(!out.includes("<div"));
  assert.ok(out.includes("x"));
  assert.ok(out.includes("w"));
});

test("htmlToText strips an UNCLOSED <script> to end of input (C2)", () => {
  const out = htmlToText("<p>before</p><script>var s=1; leak()");
  assert.ok(out.includes("before"));
  assert.ok(!out.includes("var s"), `JS leaked: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("leak()"), `JS leaked: ${JSON.stringify(out)}`);
});

test("htmlToText strips an UNCLOSED <style> to end of input (C2)", () => {
  const out = htmlToText("<p>before</p><style>.a{color:red} body{margin:0}");
  assert.ok(out.includes("before"));
  assert.ok(!out.includes("color:red"), JSON.stringify(out));
  assert.ok(!out.includes("margin"), JSON.stringify(out));
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

test("extractTitle keeps an apostrophe inside a double-quoted og:title (C3)", () => {
  const html = `<meta property="og:title" content="A 'b' c">`;
  assert.equal(extractTitle(html), "A 'b' c");
});

test("extractTitle keeps a double-quote inside a single-quoted og:title (C3)", () => {
  const html = `<meta property='og:title' content='A "b" c'>`;
  assert.equal(extractTitle(html), 'A "b" c');
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
      headers: { get: (_k: string) => null },
      text: async () => html,
    }) as unknown as Response) as unknown as typeof fetch;
}

// Hermetic DNS: resolve every name to a public IP so the SSRF guard's resolution
// check passes without touching the network.
const fakeLookup = (async (_h: string, _o: { all: true }) => [
  { address: "93.184.216.34", family: 4 },
]) as any;

// A fetch that fails the test if it is ever called — proves the SSRF guard
// rejects BEFORE any network call.
const failIfCalled = (async () => {
  throw new Error("fetch should not be called for a blocked target");
}) as unknown as typeof fetch;

test("fetchWebDocument builds the IndexableDocument shape from canned HTML", async () => {
  const html =
    '<html><head><meta property="og:title" content="My Article"></head><body><p>Hello world body.</p></body></html>';
  const doc = await fetchWebDocument("https://example.com/post/", {
    workspace: "personal",
    fetchImpl: stubFetch(200, html),
    lookupImpl: fakeLookup,
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
    lookupImpl: fakeLookup,
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
        lookupImpl: fakeLookup,
      }),
    /HTTP 404/,
  );
});

// --- SSRF guard (M1) --------------------------------------------------------

test("isBlockedHost: literal private/loopback/link-local IPs are blocked", () => {
  assert.equal(isBlockedHost("127.0.0.1"), true);
  assert.equal(isBlockedHost("10.0.0.1"), true);
  assert.equal(isBlockedHost("172.16.5.4"), true);
  assert.equal(isBlockedHost("192.168.1.1"), true);
  assert.equal(isBlockedHost("169.254.169.254"), true); // cloud metadata
  assert.equal(isBlockedHost("::1"), true);
  assert.equal(isBlockedHost("[::1]"), true);
  assert.equal(isBlockedHost("fe80::1"), true);
  assert.equal(isBlockedHost("fd00::1"), true);
});

test("isBlockedHost: localhost and own-tailnet names are blocked", () => {
  assert.equal(isBlockedHost("localhost"), true);
  assert.equal(isBlockedHost("foo.localhost"), true);
  assert.equal(isBlockedHost("vps-1200754.tail30b723.ts.net"), true);
});

test("isBlockedHost: public hosts/IPs are allowed", () => {
  assert.equal(isBlockedHost("example.com"), false);
  assert.equal(isBlockedHost("8.8.8.8"), false);
  assert.equal(isBlockedHost("172.32.0.1"), false); // just outside 172.16/12
});

test("fetchWebDocument rejects a non-http(s) scheme before fetching", async () => {
  await assert.rejects(
    () => fetchWebDocument("file:///etc/passwd", { workspace: "personal", fetchImpl: failIfCalled, lookupImpl: fakeLookup }),
    /blocked_scheme/,
  );
  await assert.rejects(
    () => fetchWebDocument("ftp://example.com/x", { workspace: "personal", fetchImpl: failIfCalled, lookupImpl: fakeLookup }),
    /blocked_scheme/,
  );
});

test("fetchWebDocument rejects a literal private/loopback target before fetching", async () => {
  for (const u of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:5432/",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/",
  ]) {
    await assert.rejects(
      () => fetchWebDocument(u, { workspace: "personal", fetchImpl: failIfCalled, lookupImpl: fakeLookup }),
      /blocked_host/,
      `expected ${u} to be blocked`,
    );
  }
});

test("fetchWebDocument rejects a public name that RESOLVES to a private IP (DNS-rebind)", async () => {
  const rebindLookup = (async () => [{ address: "10.1.2.3", family: 4 }]) as any;
  await assert.rejects(
    () => fetchWebDocument("https://evil.example/", { workspace: "personal", fetchImpl: failIfCalled, lookupImpl: rebindLookup }),
    /private/,
  );
});
