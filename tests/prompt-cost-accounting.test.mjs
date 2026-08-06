import assert from "node:assert/strict";
import test from "node:test";
import { calculateChatModelCost, calculateChatRunCost, calculateUsageCost } from "../lib/usage-pricing.ts";

const pricing = {
  provider: "test-provider",
  model: "test-model",
  label: "Test model",
  inputUsdPerMillion: 1.2,
  cachedInputUsdPerMillion: 0.2,
  outputUsdPerMillion: 2.5,
  requestUsd: 0.01,
  reasoningUsdPerMillion: 4,
};

test("calculates request, uncached input, cached input, output, and reasoning costs", () => {
  const usage = {
    promptTokens: 1_000_000,
    cachedPromptTokens: 250_000,
    completionTokens: 400_000,
    reasoningTokens: 100_000,
  };
  const expected = 0.75 * 1.2 + 0.25 * 0.2 + 0.4 * 2.5 + 0.1 * 4 + 0.01;

  assert.equal(calculateUsageCost(usage, pricing), expected);
  assert.equal(calculateChatModelCost(usage, pricing), expected);
});

test("charges the request fee when no token usage is reported", () => {
  const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };

  assert.equal(calculateUsageCost(usage, pricing), pricing.requestUsd);
  assert.equal(calculateChatModelCost(usage, pricing), pricing.requestUsd);
});

test("calculateChatRunCost prefers an exact provider cost over pricing estimates", () => {
  const exactCostUsd = 0.123456;

  assert.deepEqual(calculateChatRunCost([{
    exactCostUsd,
    usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, reasoningTokens: 1_000_000 },
    pricing: null,
  }]), {
    costUsd: exactCostUsd,
    source: "exact",
  });
});

test("returns null and marks a run unpriced when required pricing is missing", () => {
  const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 1 };
  const missingReasoningPricing = { ...pricing, reasoningUsdPerMillion: null };

  assert.equal(calculateUsageCost(usage, null), null);
  assert.equal(calculateChatModelCost(usage, null), null);
  assert.equal(calculateUsageCost(usage, missingReasoningPricing), null);
  assert.equal(calculateChatModelCost(usage, missingReasoningPricing), null);
  assert.deepEqual(calculateChatRunCost([{ usage, pricing: null }]), {
    costUsd: null,
    source: "unpriced",
  });
  assert.deepEqual(calculateChatRunCost([{ usage, pricing: missingReasoningPricing }]), {
    costUsd: null,
    source: "unpriced",
  });
});
