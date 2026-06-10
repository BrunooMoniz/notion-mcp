// src/crypto-utils.ts
// Shared cryptographic helpers. Kept in a separate module with no side-effects
// so they can be imported by both oauth.ts and admin/routes.ts without pulling
// in process.exit() guards from oauth.ts module-level init code.
import { timingSafeEqual } from "node:crypto";

/**
 * Timing-safe string equality. Returns false immediately when lengths differ
 * (avoids Buffer.alloc mismatch error), then uses timingSafeEqual to compare
 * byte-by-byte without short-circuiting on mismatch (guards against timing attacks).
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
