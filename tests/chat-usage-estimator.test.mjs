import assert from "node:assert/strict";
import test from "node:test";
import { ChatUsageEstimator } from "../app/chat/chat-usage-estimator.ts";
import { estimateUsageFromText } from "../lib/usage-pricing.ts";

function legacyEstimate(input, output) {
  return estimateUsageFromText(JSON.stringify(input), output);
}

test("incremental chat usage estimation preserves the legacy character totals", () => {
  const input = {
    messages: [{ role: "user", content: "Use the tool." }],
    systemPrompt: "system context",
    userPresence: "user presence",
  };
  const instructions = ["Use tools carefully.", "Return concise answers."];
  const tools = [{
    type: "function",
    function: {
      name: "check_time",
      description: "Check the current time.",
      parameters: { type: "object", additionalProperties: false },
    },
  }];
  const rounds = [];
  const estimator = new ChatUsageEstimator(input);

  const firstOutput = "First answer";
  assert.deepEqual(
    estimator.estimate({ replayRounds: rounds, systemInstructions: instructions, tools, output: firstOutput }),
    legacyEstimate({ ...input, replayRounds: rounds, systemInstructions: instructions, tools }, firstOutput),
  );

  rounds.push({ content: "", toolCalls: [{ id: "call-1", name: "check_time", arguments: "{}", result: { ok: true } }] });
  const secondOutput = "Second answer";
  assert.deepEqual(
    estimator.estimate({ replayRounds: rounds, systemInstructions: instructions, tools, output: secondOutput }),
    legacyEstimate({ ...input, replayRounds: rounds, systemInstructions: instructions, tools }, secondOutput),
  );
});

test("incremental estimation does not re-serialize unchanged history or tool entries", () => {
  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = (...args) => {
    stringifyCalls += 1;
    return originalStringify(...args);
  };

  try {
    const estimator = new ChatUsageEstimator({
      messages: [{ role: "user", content: "Use the tool." }],
      systemPrompt: "system context",
      userPresence: "user presence",
    });
    const systemInstructions = ["Use tools carefully."];
    const tools = [{ type: "function", function: { name: "check_time", parameters: {} } }];
    const rounds = [];

    estimator.estimate({ replayRounds: rounds, systemInstructions, tools, output: "first" });
    const firstEstimateCalls = stringifyCalls;
    rounds.push({ content: "", toolCalls: [] });
    estimator.estimate({ replayRounds: rounds, systemInstructions, tools, output: "second" });
    const secondEstimateCalls = stringifyCalls;
    estimator.estimate({ replayRounds: rounds, systemInstructions, tools, output: "third" });

    assert.ok(secondEstimateCalls > firstEstimateCalls);
    assert.equal(stringifyCalls, secondEstimateCalls);
  } finally {
    JSON.stringify = originalStringify;
  }
});
