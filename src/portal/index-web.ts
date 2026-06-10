// src/portal/index-web.ts
// 002-app-v2 — POST /portal/index-web ("colar URL no Consultar"). The heavy
// lifting (quota, fetch+SSRF guard, chunk/embed, replace-on-write, metering)
// is the SAME core the brain_index_web MCP tool uses (indexWebForAccount in
// rag/brain-index-web-tool.ts) with the SESSION account passed explicitly.
// This module only owns the cheap input validation, exported pure for tests.

/**
 * Validate a user-pasted URL: must be a parseable absolute http(s) URL
 * (mirrors the MCP tool's z.string().url() + the fetcher's scheme check).
 * Returns the normalized href, or null when invalid.
 */
export function parseHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.href;
}
