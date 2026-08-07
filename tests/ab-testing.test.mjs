import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAbAssignmentToChatRequest,
  normalizeAbExperimentMutation,
  normalizeAbOverridePatch,
  runtimeOverridesForAssignment,
} from "../app/server/ab-testing/ab-testing-service.ts";
import { runtimeConfigSnapshot, withRuntimeConfigOverrides } from "../app/server/config/runtime-config-service.ts";
import { DEFAULT_CHAT_SYSTEM_PROMPT, parseChatRequest } from "../lib/chat-protocol.ts";

const model = { provider: "deepseek", model: "deepseek-v4-flash" };

test("A/B candidates use existing runtime descriptor validation and preserve independent patches", () => {
  const patch = normalizeAbOverridePatch({
    "runtime.searchProviderCacheTtlMs": 45_000,
    "runtime.searxngUrl": "https://search.example.test",
  });
  assert.deepEqual(patch, {
    "runtime.searchProviderCacheTtlMs": 45_000,
    "runtime.searxngUrl": "https://search.example.test",
  });
  assert.deepEqual(runtimeOverridesForAssignment({
    id: "assignment-1",
    experimentId: "experiment-1",
    experimentName: "Search cache",
    variant: "a",
    overrides: patch,
    retry: false,
  }), {
    searchProviderCacheTtlMs: 45_000,
    searxngUrl: "https://search.example.test",
  });
});

test("runtime candidates are scoped to one generation and do not mutate Configurables", () => {
  const baseline = runtimeConfigSnapshot().searchProviderCacheTtlMs;
  const scoped = withRuntimeConfigOverrides({ searchProviderCacheTtlMs: 1_234 }, () => runtimeConfigSnapshot().searchProviderCacheTtlMs);
  assert.equal(scoped, 1_234);
  assert.equal(runtimeConfigSnapshot().searchProviderCacheTtlMs, baseline);
});

test("experiment variants must test the same settings and differ", () => {
  assert.throws(
    () => normalizeAbExperimentMutation({
      name: "Mismatch",
      variantA: { "chat.thinking": true },
      variantB: { "chat.reasoningEffort": "low" },
    }),
    /same settings/,
  );
  assert.throws(
    () => normalizeAbExperimentMutation({
      name: "Same",
      variantA: { "chat.thinking": true },
      variantB: { "chat.thinking": true },
    }),
    /differ/,
  );
});

test("chat candidates override only declared fields and retain the experiment assignment", () => {
  const request = parseChatRequest({
    messages: [{ role: "user", content: "hello" }],
    systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    userPresence: "",
    model,
    thinking: true,
    reasoningEffort: "high",
    conversationId: "conversation-1",
    jobId: "job-1",
    idempotencyKey: "job-1",
    persistence: {
      turnId: "turn-1",
      versionId: "version-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      turnIndex: 0,
      versionIndex: 0,
    },
  });
  const assignment = {
    id: "assignment-1",
    experimentId: "experiment-1",
    experimentName: "Model comparison",
    variant: "b",
    overrides: {
      "chat.model": { provider: "openrouter", model: "example/model" },
      "chat.reasoningEffort": "low",
    },
    retry: false,
  };
  const next = applyAbAssignmentToChatRequest(request, assignment);
  assert.deepEqual(next.model, { provider: "openrouter", model: "example/model" });
  assert.equal(next.reasoningEffort, "low");
  assert.equal(next.thinking, true);
  assert.equal(next.systemPrompt, request.systemPrompt);
  assert.deepEqual(next.experiment, assignment);
});

test("retry metadata is accepted without changing the canonical system prompt", () => {
  const request = parseChatRequest({
    messages: [{ role: "user", content: "retry me" }],
    systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    userPresence: "",
    model,
    thinking: true,
    reasoningEffort: "high",
    conversationId: "conversation-1",
    jobId: "job-2",
    idempotencyKey: "job-2",
    persistence: {
      turnId: "turn-1",
      versionId: "version-2",
      userMessageId: "user-2",
      assistantMessageId: "assistant-2",
      turnIndex: 0,
      versionIndex: 1,
      retryOfVersionId: "version-1",
    },
  });
  assert.equal(request.persistence?.retryOfVersionId, "version-1");
  assert.match(request.systemPrompt, /bobert_behavior/);
});
