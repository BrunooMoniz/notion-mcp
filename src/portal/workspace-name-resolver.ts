// src/portal/workspace-name-resolver.ts
// 1.2 — Resolve the human-readable Notion workspace name from a token (PAT or OAuth
// access token) by calling GET /v1/users/me. Returns null on any failure so
// callers (backfill script) can skip gracefully without crashing.
// fetchImpl is injectable for tests (same pattern as validatePat).

const ME_URL = "https://api.notion.com/v1/users/me";
// Keep in sync with NOTION_API_VERSION in clients.ts.
const NOTION_VERSION = "2025-09-03";

/**
 * Resolve the Notion workspace name for a given token.
 * Works with both PAT (ntn_*) and OAuth access tokens.
 * Returns the workspace name string, or null if the token is invalid
 * or the request fails (so the backfill can continue without crashing).
 */
export async function resolveWorkspaceName(
  token: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(ME_URL, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    const text = await res.text();
    let me: any;
    try {
      me = text ? JSON.parse(text) : {};
    } catch {
      return null;
    }
    if (!res.ok) return null;
    // Primary: bot.workspace_name (set for both PAT and OAuth bot tokens)
    // Fallback: top-level name field (person tokens)
    return me?.bot?.workspace_name ?? me?.name ?? null;
  } catch {
    return null;
  }
}
