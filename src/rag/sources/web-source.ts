// src/rag/sources/web-source.ts
// F2.2: the first pluggable connector — web capture. Indexes an arbitrary web
// URL into the brain RAG. ZERO new dependencies: Node 22's global `fetch` plus a
// hand-rolled HTML->text extractor (the helpers below are pure and unit-tested).

import dns from "node:dns/promises";
import net from "node:net";
import type {
  IndexableDocument,
  Source,
  SourcePassOptions,
  Workspace,
} from "../types.js";

// --- entity decoding --------------------------------------------------------
// Only the handful of entities that actually show up in prose. Numeric refs
// (decimal &#NN; and hex &#xNN;) are decoded generically.
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [ent, ch] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(ent).join(ch);
  }
  // Numeric: decimal &#NN; and hex &#xNN;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
    safeFromCodePoint(parseInt(hex, 16)),
  );
  out = out.replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)));
  return out;
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

// --- htmlToText (pure) ------------------------------------------------------
// Strip non-content blocks, turn block-level tags into newlines, drop all other
// tags, decode entities, and normalize whitespace. Deliberately simple — good
// enough to feed the chunker, not a full DOM.
export function htmlToText(html: string): string {
  let s = html;

  // Drop comments and non-content blocks entirely (incl. their inner text).
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Well-formed script/style/noscript/svg (open..close).
  s = s.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // C2: an UNTERMINATED script/style/noscript/svg (truncated page, no closing
  // tag) — strip from the open tag to end-of-input so JS/CSS source can never
  // leak into the indexed body.
  s = s.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*$/gi, " ");

  // Block-level / line-breaking tags -> newline. Closing tags for blocks plus
  // <br> and list items.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n");

  // C1: strip only REAL tags — an opening/closing tag starts with a letter or
  // `/`, and a declaration starts with `<!`. A bare `<` in prose (e.g. "a < 5"
  // or "5 > 3" or code/math) is NOT a tag and must survive.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/<![^>]*>/g, "");

  // Decode entities after tag removal so e.g. &lt;b&gt; stays literal text.
  s = decodeEntities(s);

  // Normalize whitespace: trim trailing spaces per line, collapse 3+ newlines
  // to 2, collapse runs of spaces/tabs.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// --- extractTitle (pure) ----------------------------------------------------
// Prefer og:title, then <title>. Returns null when neither is present.
export function extractTitle(html: string): string | null {
  // C3: capture the content value by matching its actual surrounding quote with
  // a backreference (\1), so an apostrophe inside a double-quoted value (or a
  // double-quote inside a single-quoted value) is not truncated.
  const og =
    html.match(
      /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*(["'])([\s\S]*?)\1/i,
    ) ??
    // content attribute may precede property
    html.match(
      /<meta\b[^>]*\bcontent\s*=\s*(["'])([\s\S]*?)\1[^>]*\bproperty\s*=\s*["']og:title["']/i,
    );
  if (og && og[2].trim()) return decodeEntities(og[2]).trim();

  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return decodeEntities(t[1]).replace(/\s+/g, " ").trim();

  return null;
}

// --- SSRF guard (M1) --------------------------------------------------------
// brain_index_web fetches an arbitrary user-supplied URL server-side and stores
// the response body in the brain, so a request to an internal/loopback target
// would exfiltrate it into search results. We block private/loopback/link-local/
// unique-local destinations (by literal IP and by resolved DNS address) and
// non-http(s) schemes, and re-validate every redirect hop. Proportionate to a
// single-user VPS — not a full SSRF library.

/** Is a literal IP (v4 or v6) in a private/loopback/link-local/ULA range? */
function ipInPrivateRange(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 127) return true;              // this-host / loopback
    if (o[0] === 10) return true;                             // 10/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;            // 192.168/16
    if (o[0] === 169 && o[1] === 254) return true;            // link-local
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80")) return true;                    // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (mapped) return ipInPrivateRange(mapped[1]);
    return false;
  }
  return false;
}

/**
 * Pure host check for literal IPs and obvious local names (no DNS). Blocks
 * loopback/private/link-local/ULA IPs, `localhost`/`*.localhost`, and the
 * server's own tailnet (`*.ts.net`). DNS names resolve+check in assertHostAllowed.
 */
export function isBlockedHost(hostname: string): boolean {
  if (!hostname) return true;
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // IPv6 literal
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".ts.net")) return true;                       // own tailnet
  if (net.isIP(h)) return ipInPrivateRange(h);
  return false;
}

type LookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

async function assertHostAllowed(hostname: string, lookupImpl?: LookupAll): Promise<void> {
  if (isBlockedHost(hostname)) {
    throw new Error(`blocked_host: ${hostname} (private/loopback/local)`);
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return; // literal public IP already validated above
  // DNS name: resolve and reject if ANY address is private (DNS-rebind/SSRF).
  const lookup = lookupImpl ?? (dns.lookup as unknown as LookupAll);
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (e: any) {
    throw new Error(`dns_lookup_failed: ${hostname}: ${e?.message ?? e}`);
  }
  for (const a of addrs) {
    if (ipInPrivateRange(a.address)) {
      throw new Error(`blocked_host: ${hostname} resolves to private ${a.address}`);
    }
  }
}

// --- normalizeWebId (pure) --------------------------------------------------
// Stable id from a URL: lowercase host, strip the fragment and a trailing
// slash, keep the query. Falls back to a trimmed raw string for non-URLs.
export function normalizeWebId(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    // Drop a trailing slash on the path so these collapse to one id:
    //   https://x.com/a/      -> https://x.com/a
    //   https://x.com/        -> https://x.com
    //   https://x.com/a/?q=1  -> https://x.com/a?q=1
    const path = u.pathname.replace(/\/+$/, "");
    const query = u.search; // includes leading "?" or ""
    return `${u.protocol}//${u.host}${path}${query}`;
  } catch {
    return url.trim();
  }
}

// --- fetchWebDocument -------------------------------------------------------
const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on the fetched body (I9)

export async function fetchWebDocument(
  url: string,
  opts: {
    workspace: Workspace | null;
    fetchImpl?: typeof fetch;
    lookupImpl?: LookupAll; // injectable DNS for hermetic tests
  },
): Promise<IndexableDocument> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = url;
  let res: Response | undefined;

  // Manual redirect follow so we re-validate the host of EVERY hop (a public
  // page can 30x to an internal target — `redirect: "follow"` would hide it).
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new Error(`invalid_url: ${current}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`blocked_scheme: ${u.protocol}`);
    }
    await assertHostAllowed(u.hostname, opts.lookupImpl);

    res = await doFetch(current, {
      headers: {
        // A real UA — some sites 403 the default fetch agent.
        "user-agent":
          "Mozilla/5.0 (compatible; notion-mcp-brain/1.0; +https://github.com)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
    });

    const location =
      res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null;
    if (location) {
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }

  if (!res) throw new Error(`no_response: ${url}`);
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`too_many_redirects: ${url}`);
  }
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }

  // Size cap: reject early on a declared oversized body, and truncate as a
  // backstop (a hostile/huge page shouldn't blow up the chunker/embedder).
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`body_too_large: ${declared} bytes (max ${MAX_BYTES})`);
  }
  let html = await res.text();
  if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);

  const title = extractTitle(html);
  const body = htmlToText(html);
  const fetchedAt = new Date();

  return {
    source_type: "web",
    source_id: normalizeWebId(url),
    workspace: opts.workspace,
    db_name: null,
    parent_url: url,
    text: title ? `${title}\n\n${body}` : body,
    metadata: { title, url, fetched_at: fetchedAt.toISOString() },
    source_updated: fetchedAt,
  };
}

// --- webSource (the periodic-feed connector) --------------------------------
// Configured via WEB_SOURCES: a JSON array of { url, workspace, label? }. The
// periodic indexer pass fetches each entry. (On-demand single-URL capture goes
// through the brain_index_web MCP tool instead.)

interface WebFeedEntry {
  url: string;
  workspace: Workspace | null;
  label?: string;
}

function parseWebSources(): WebFeedEntry[] {
  const raw = process.env.WEB_SOURCES;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      url: String((e as any).url ?? ""),
      workspace: ((e as any).workspace ?? null) as Workspace | null,
      label: typeof (e as any).label === "string" ? (e as any).label : undefined,
    }))
    .filter((e) => e.url.length > 0);
}

export const webSource: Source = {
  name: "web",
  sourceType: "web",
  isConfigured(): boolean {
    return parseWebSources().length > 0;
  },
  async *listDocuments(_opts: SourcePassOptions): AsyncIterable<IndexableDocument> {
    for (const entry of parseWebSources()) {
      // Per-entry resilience: one unreachable/blocked URL must not abort the
      // rest of the curated feed.
      try {
        yield await fetchWebDocument(entry.url, { workspace: entry.workspace });
      } catch (err: any) {
        console.warn(`[web-source] skip ${entry.url}: ${err?.message ?? err}`);
      }
    }
  },
};
