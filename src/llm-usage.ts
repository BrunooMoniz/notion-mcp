// src/llm-usage.ts
// F2 — LLM usage metering per account.
// Records llm_input_tokens and llm_output_tokens in usage_log so the admin can
// show per-account token consumption and estimate LLM cost.
// Deps fully injectable for unit tests (no real DB needed).
import { recordUsage } from "./rag/usage.js";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Record LLM token usage for an account. Two rows per call: one for input
 * tokens, one for output tokens. label is a descriptive tag (e.g. "ask",
 * "classifier", "router") kept for future debugging but not stored in the DB.
 *
 * Best-effort: recordUsage already swallows errors, so this function is safe
 * to fire-and-forget without breaking the caller.
 *
 * Injectable for tests: pass a custom `writer` to avoid real DB calls.
 */
export async function recordLlmUsage(
  accountId: string,
  usage: LlmUsage,
  _label: string,
  writer: typeof recordUsage = recordUsage,
): Promise<void> {
  const promises: Promise<void>[] = [];
  if (usage.input_tokens > 0) {
    promises.push(writer(accountId, "llm_input_tokens", usage.input_tokens));
  }
  if (usage.output_tokens > 0) {
    promises.push(writer(accountId, "llm_output_tokens", usage.output_tokens));
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
