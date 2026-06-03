// src/getAllowedWorkspaces.ts
// Workspace-scope helper for the brain tools (F.4.1).
//
// `getContext()` (context.ts) returns the per-request RequestContext (typed
// scopes: Workspace[] | "all") or `undefined` outside an HTTP request
// (startup / cron / tests / eval harness). `Workspace` itself is defined in
// clients.ts, which context.ts re-uses but does not re-export — so import it
// from its real home.
import { getContext } from "./context.js";
import type { Workspace } from "./clients.js";

let _getContext = getContext;
export function __setContextGetterForTest(fn: typeof getContext): void {
  _getContext = fn;
}

/**
 * Returns null when there is NO workspace filter to apply:
 *   - no request context (startup / cron / tests / eval harness), OR
 *   - scopes === "all" (bearer / Claude Code).
 * Otherwise returns the allowed Workspace[] for a scoped OAuth token.
 */
export function getAllowedWorkspaces(): Workspace[] | null {
  const ctx = _getContext();
  if (!ctx) return null;
  if (ctx.scopes === "all") return null;
  return ctx.scopes;
}
