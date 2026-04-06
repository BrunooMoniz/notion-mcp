import { AsyncLocalStorage } from "node:async_hooks";
import type { Workspace } from "./clients.js";

export type TokenScopes = Workspace[] | "all";

export interface RequestContext {
  authType: "bearer" | "oauth";
  scopes: TokenScopes;
  clientId?: string;
  ip?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Enforces that the current request's token is authorized for the given workspace.
 * - Bearer token (Claude Code) has scopes="all" and always passes.
 * - OAuth tokens (Claude.ai) carry the scope list chosen at consent time.
 * - If no context exists (e.g. startup code, tests), allow — the check only
 *   applies to HTTP-originated calls which are always wrapped by the middleware.
 */
export function assertWorkspaceScope(workspace: Workspace): void {
  const ctx = requestContext.getStore();
  if (!ctx) return;
  if (ctx.scopes === "all") return;
  if (!ctx.scopes.includes(workspace)) {
    throw new Error(
      `Access denied: token is not scoped for workspace "${workspace}". Authorized: ${ctx.scopes.join(", ") || "(none)"}`
    );
  }
}
