import { Client } from "@notionhq/client";
import { assertWorkspaceScope } from "./context.js";

const notionTokens = [
  "NOTION_GLOBALCRIPTO_TOKEN",
  "NOTION_PERSONAL_TOKEN",
  "NOTION_NORA_TOKEN",
] as const;

for (const key of notionTokens) {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  if (!val.startsWith("ntn_")) {
    console.error(`Invalid format for ${key}: must start with "ntn_"`);
    process.exit(1);
  }
}

if (!process.env.OAUTH_PASSWORD_HASH) {
  console.error(
    "Missing required environment variable: OAUTH_PASSWORD_HASH.\n" +
      "Generate one with: node scripts/hash-password.mjs '<your-password>'"
  );
  process.exit(1);
}

const bearerToken = process.env.BEARER_TOKEN;
if (bearerToken && bearerToken.length < 32) {
  console.error("BEARER_TOKEN must be at least 32 characters");
  process.exit(1);
}

// Notion API version. 2025-09-03 unlocks multi-source databases,
// data_sources endpoints, comments threading, and file uploads.
export const NOTION_API_VERSION = "2025-09-03";

export const globalcriptoClient = new Client({
  auth: process.env.NOTION_GLOBALCRIPTO_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

export const personalClient = new Client({
  auth: process.env.NOTION_PERSONAL_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

export const noraClient = new Client({
  auth: process.env.NOTION_NORA_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

export type Workspace = "globalcripto" | "personal" | "nora";

export const ALL_WORKSPACES: Workspace[] = ["globalcripto", "personal", "nora"];

export function getClient(workspace: Workspace): Client {
  // Per-request scope enforcement (no-op when there's no HTTP context).
  assertWorkspaceScope(workspace);
  switch (workspace) {
    case "globalcripto":
      return globalcriptoClient;
    case "personal":
      return personalClient;
    case "nora":
      return noraClient;
    default: {
      const _exhaustive: never = workspace;
      throw new Error(`Unknown workspace: ${_exhaustive}`);
    }
  }
}

export function getToken(workspace: Workspace): string {
  assertWorkspaceScope(workspace);
  switch (workspace) {
    case "globalcripto":
      return process.env.NOTION_GLOBALCRIPTO_TOKEN!;
    case "personal":
      return process.env.NOTION_PERSONAL_TOKEN!;
    case "nora":
      return process.env.NOTION_NORA_TOKEN!;
    default: {
      const _exhaustive: never = workspace;
      throw new Error(`Unknown workspace: ${_exhaustive}`);
    }
  }
}

export interface NotionFetchInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  contentType?: string;
  rawBody?: BodyInit;
}

/**
 * Raw HTTP call to the Notion REST API for endpoints not yet covered by
 * the @notionhq/client SDK (data sources, file uploads, etc).
 * Adds workspace-scoped auth + the active Notion-Version header.
 */
export async function notionFetch(
  workspace: Workspace,
  path: string,
  init: NotionFetchInit = {}
): Promise<unknown> {
  const token = getToken(workspace);
  const base = path.startsWith("http") ? path : `https://api.notion.com${path}`;
  let url = base;
  if (init.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const sep = base.includes("?") ? "&" : "?";
    url = base + (qs.toString() ? `${sep}${qs.toString()}` : "");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
  };
  if (init.contentType) {
    headers["Content-Type"] = init.contentType;
  } else if (init.body !== undefined && !init.rawBody) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });

  const text = await resp.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!resp.ok) {
    const err = (data ?? {}) as { message?: string; code?: string; request_id?: string };
    const msg = err.message ?? `HTTP ${resp.status}`;
    const e = new Error(msg) as Error & { code?: string; request_id?: string; status?: number };
    e.code = err.code;
    e.request_id = err.request_id;
    e.status = resp.status;
    throw e;
  }
  return data;
}
