import type { ChatModelPricing, ChatRunCost, ChatUsage } from "./chat-protocol";
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

export function calculateChatModelCost(usage: ChatUsage, pricing: ChatModelPricing | null): number | null {
  if (!pricing) return null;
  const normalized = normalizeUsage(usage);
  const promptTokens = normalized.promptTokens ?? 0;
  const completionTokens = normalized.completionTokens ?? 0;
  const reasoningTokens = normalized.reasoningTokens ?? 0;
  const cachedPromptTokens = Math.min(promptTokens, normalized.cachedPromptTokens ?? 0);
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;
  const hasTokenUsage = promptTokens > 0 || completionTokens > 0;

  if (hasTokenUsage && (pricing.inputUsdPerMillion === null || pricing.outputUsdPerMillion === null)) return null;

  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion ?? 0;
  const tokenCost = (
    uncachedPromptTokens * (pricing.inputUsdPerMillion ?? 0)
    + cachedPromptTokens * cachedRate
    + completionTokens * (pricing.outputUsdPerMillion ?? 0)
    + reasoningTokens * (pricing.reasoningUsdPerMillion ?? 0)
  ) / 1_000_000;
  return tokenCost + (pricing.requestUsd ?? 0);
}

export type ChatRunCostInput = {
  usage?: ChatUsage | null;
  exactCostUsd?: number;
  pricing?: ChatModelPricing | null;
};

function nonNegativeFinite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function calculateChatRunCost(rounds: readonly ChatRunCostInput[]): ChatRunCost {
  if (!rounds.length) return { costUsd: null, source: "unpriced" };

  let total = 0;
  let exact = true;
  for (const round of rounds) {
    const exactCost = nonNegativeFinite(round.exactCostUsd);
    if (exactCost !== null) {
      total += exactCost;
      continue;
    }
    if (!round.usage) return { costUsd: null, source: "unpriced" };
    const estimatedCost = calculateChatModelCost(round.usage, round.pricing ?? null);
    if (estimatedCost === null) return { costUsd: null, source: "unpriced" };
    total += estimatedCost;
    exact = false;
  }

  return { costUsd: total, source: exact ? "exact" : "estimated" };
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
