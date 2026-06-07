import { AsyncLocalStorage } from "node:async_hooks";
import type { Workspace } from "./clients.js";

export type TokenScopes = Workspace[] | "all";

export interface RequestContext {
  authType: "bearer" | "oauth";
  scopes: TokenScopes;
  clientId?: string;
  ip?: string;
  /**
   * F3.0 — the tenant this request belongs to. Set from the auth layer (never
   * from tool input). Absent today (single-account); resolved by getAccountId()
   * to the default account so current behavior is unchanged.
   */
  accountId?: string;
  /**
   * WS2 hardening — POSITIVE owner/operator signal set by the auth layer for the
   * operator (Bruno): the static "all" bearer, or an operator-issued OAuth token.
   * Owner status must never be inferred from the mere ABSENCE of accountId (that
   * is fail-open: a friend token without accountId would inherit the owner tools).
   */
  isOperator?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The single current account until Fase 3 onboarding lands real tenants. */
export const DEFAULT_ACCOUNT_ID = "bruno";

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * F3.0 — the account_id to scope storage reads/writes by. Mirrors the workspace
 * model: out-of-request contexts (startup/cron/eval/tests) and any request
 * without an explicit account fall back to the default account. NEVER derive
 * this from tool arguments — it must come from the trusted auth context.
 */
export function getAccountId(): string {
  return requestContext.getStore()?.accountId ?? DEFAULT_ACCOUNT_ID;
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
