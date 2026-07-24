import type { ChatUsage } from "../../lib/chat-protocol";

export type UsageSnapshot = ChatUsage | null | undefined;

/** Keep only the last non-null provider usage snapshot observed in a round. */
export function latestNonNullUsage(current: ChatUsage | null, next: UsageSnapshot): ChatUsage | null {
  return next ?? current;
}

/**
 * Sum one finalized usage snapshot per provider round. DeepSeek can emit the
 * same round's usage more than once while streaming, so callers must first
 * collapse each round with latestNonNullUsage.
 */
export function sumRoundUsage(rounds: readonly UsageSnapshot[]): ChatUsage | null {
  const totals: ChatUsage = {};
  for (const snapshot of rounds) {
    if (!snapshot) continue;
    if (snapshot.promptTokens !== undefined) {
      totals.promptTokens = (totals.promptTokens ?? 0) + snapshot.promptTokens;
    }
    if (snapshot.completionTokens !== undefined) {
      totals.completionTokens = (totals.completionTokens ?? 0) + snapshot.completionTokens;
    }
    if (snapshot.totalTokens !== undefined) {
      totals.totalTokens = (totals.totalTokens ?? 0) + snapshot.totalTokens;
    }
    if (snapshot.reasoningTokens !== undefined) {
      totals.reasoningTokens = (totals.reasoningTokens ?? 0) + snapshot.reasoningTokens;
    }
  }
  return Object.values(totals).some((value) => value !== undefined) ? totals : null;
}
