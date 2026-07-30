import type { ChatUsage } from "./chat-protocol";
import type { UsagePricing } from "./usage-protocol";

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeUsage(usage: ChatUsage): ChatUsage {
  const promptTokens = nonNegative(usage.promptTokens);
  const completionTokens = nonNegative(usage.completionTokens);
  const cachedPromptTokens = Math.min(promptTokens, nonNegative(usage.cachedPromptTokens));
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens === undefined
      ? promptTokens + completionTokens
      : nonNegative(usage.totalTokens),
    ...(cachedPromptTokens ? { cachedPromptTokens } : {}),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: nonNegative(usage.reasoningTokens) }),
  };
}

export function calculateUsageCost(usage: ChatUsage, pricing: UsagePricing | null): number | null {
  if (!pricing) return null;
  const normalized = normalizeUsage(usage);
  const promptTokens = normalized.promptTokens ?? 0;
  const completionTokens = normalized.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return 0;
  const cachedPromptTokens = Math.min(promptTokens, normalized.cachedPromptTokens ?? 0);
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  return (
    uncachedPromptTokens * pricing.inputUsdPerMillion
    + cachedPromptTokens * cachedRate
    + completionTokens * pricing.outputUsdPerMillion
  ) / 1_000_000;
}

export function estimateUsageFromText(input: string, output: string): ChatUsage {
  return estimateUsageFromCharacterCounts(input.length, output.length);
}

export function estimateUsageFromCharacterCounts(inputCharacters: number, outputCharacters: number): ChatUsage {
  // Provider tokenizers are not interchangeable. This intentionally simple
  // fallback is marked as estimated everywhere it is persisted.
  const promptTokens = Math.max(1, Math.ceil(Math.max(0, inputCharacters) / 4));
  const completionTokens = outputCharacters > 0 ? Math.max(1, Math.ceil(outputCharacters / 4)) : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
