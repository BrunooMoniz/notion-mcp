// src/portal/connection-type.ts
// 1.3 — Derive the Notion connection type (PAT vs OAuth) from the vault secret kind.
// The secret kind is the key under which the token is stored in account_secrets:
//   notion_pat:<workspace>   -> user supplied a Personal Access Token
//   notion_access:<workspace> / notion_refresh:<workspace> -> OAuth flow

export type NotionConnectionType = "pat" | "oauth";

/**
 * Derive the connection type from a vault secret kind string.
 * Returns null for non-Notion kinds (granola, ical, etc.).
 */
export function connectionTypeFromKind(kind: string): NotionConnectionType | null {
  if (kind.startsWith("notion_pat:")) return "pat";
  if (kind.startsWith("notion_access:") || kind.startsWith("notion_refresh:")) return "oauth";
  return null;
}

/**
 * Human-readable chip label for display in the portal.
 * Returns null for unrecognized types.
 */
export function connectionTypeLabel(type: NotionConnectionType | null): string | null {
  if (type === "pat") return "Token (PAT)";
  if (type === "oauth") return "OAuth";
  return null;
}
