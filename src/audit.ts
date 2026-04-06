import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getContext } from "./context.js";

const AUDIT_LOG_PATH = resolve(process.env.AUDIT_LOG_PATH ?? "./logs/audit.log");

let initialized = false;
async function ensureDir(): Promise<void> {
  if (initialized) return;
  await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
  initialized = true;
}

export interface AuditTarget {
  page_id?: string;
  database_id?: string;
  block_id?: string;
  parent?: string;
  [key: string]: unknown;
}

/**
 * Append a JSONL entry describing a mutating Notion operation.
 * Never throws — audit failures must not break tool execution.
 */
export function auditWrite(
  tool: string,
  workspace: string,
  target: AuditTarget,
  extra?: Record<string, unknown>
): void {
  const ctx = getContext();
  const entry = {
    ts: new Date().toISOString(),
    tool,
    workspace,
    target,
    auth: ctx?.authType ?? "unknown",
    client_id: ctx?.clientId,
    ip: ctx?.ip,
    ...(extra ?? {}),
  };
  // Fire-and-forget; log write errors to stderr but do not throw.
  (async () => {
    try {
      await ensureDir();
      await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error(`[audit] write failed: ${(err as Error).message}`);
    }
  })();
}
