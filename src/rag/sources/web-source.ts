// src/rag/sources/web-source.ts
// F2.2: the first pluggable connector — web capture. Indexes an arbitrary web
// URL into the brain RAG. ZERO new dependencies: Node 22's global `fetch` plus a
// hand-rolled HTML->text extractor (the helpers below are pure and unit-tested).

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
  s = s.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Block-level / line-breaking tags -> newline. Closing tags for blocks plus
  // <br> and list items.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n");

  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");

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
  const og =
    html.match(
      /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i,
    ) ??
    // content attribute may precede property
    html.match(
      /<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i,
    );
  if (og && og[1].trim()) return decodeEntities(og[1]).trim();

  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return decodeEntities(t[1]).replace(/\s+/g, " ").trim();

  return null;
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
export async function fetchWebDocument(
  url: string,
  opts: { workspace: Workspace | null; fetchImpl?: typeof fetch },
): Promise<IndexableDocument> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: {
      // A real UA — some sites 403 the default fetch agent.
      "user-agent":
        "Mozilla/5.0 (compatible; notion-mcp-brain/1.0; +https://github.com)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
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
      yield await fetchWebDocument(entry.url, { workspace: entry.workspace });
    }
  },
};
