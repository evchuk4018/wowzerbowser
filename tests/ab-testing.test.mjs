import assert from "node:assert/strict";
import test from "node:test";
import {
  assignAnonymousAbTestLabels,
  shouldAssignAbTestComparison,
} from "../app/server/ab-testing/ab-test-service.ts";
import { parseChatAbTestSubmission } from "../app/chat/chat-service.ts";
import {
  conversationReducer,
  initialConversationState,
} from "../app/chat/conversation-reducer.ts";

test("samples exactly the configured ten percent boundary", () => {
  assert.equal(shouldAssignAbTestComparison(0), true);
  assert.equal(shouldAssignAbTestComparison(0.09999), true);
  assert.equal(shouldAssignAbTestComparison(0.1), false);
  assert.equal(shouldAssignAbTestComparison(0.99999), false);
});

test("blind labels randomize which actual variant is shown as option A", () => {
  assert.deepEqual(assignAnonymousAbTestLabels(0.1), { displayAVariant: "a", displayBVariant: "b" });
  assert.deepEqual(assignAnonymousAbTestLabels(0.9), { displayAVariant: "b", displayBVariant: "a" });
});

test("submission mapping keeps actual variants separate from anonymous options", () => {
  const submission = parseChatAbTestSubmission({
    comparison: {
      trialId: "trial-1",
      comparisonId: "comparison-1",
      turnId: "turn-1",
      displayAVariant: "b",
      variants: {
        a: { assistantMessageId: "actual-a" },
        b: { assistantMessageId: "actual-b" },
      },
    },
  });
  assert.deepEqual(submission?.variantResponses, {
    a: { responseId: "actual-a", versionId: "actual-a" },
    b: { responseId: "actual-b", versionId: "actual-b" },
  });
  assert.deepEqual(submission?.options, {
    a: { responseId: "actual-b" },
    b: { responseId: "actual-a" },
  });
});

test("the reducer keeps option metadata on the canonical response until a vote", () => {
  const comparison = {
    id: "comparison-1",
    trialId: "trial-1",
    turnId: "turn-1",
    displayAVariant: "a",
    options: { a: { responseId: "answer-a" }, b: { responseId: "answer-b" } },
    status: "pending",
    selected: null,
    variantKey: "a",
  };
  const base = {
    id: "conversation-1",
    title: "Chat",
    turns: [{
      id: "turn-1",
      activeVersion: 0,
      versions: [{
        id: "version-a",
        user: { id: "prompt", role: "user", content: "hello" },
        assistant: { id: "answer-a", role: "assistant", content: "A", status: "complete", abTestComparison: comparison },
      }],
    }],
  };
  let state = conversationReducer(initialConversationState, { type: "LOAD_CONVERSATIONS", conversations: [base] });
  state = conversationReducer(state, {
    type: "APPEND_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    version: {
      id: "version-b",
      user: { id: "prompt-b", role: "user", content: "hello" },
      assistant: { id: "answer-b", role: "assistant", content: "B", status: "complete", abTestComparison: { ...comparison, variantKey: "b" } },
    },
  });
  state = conversationReducer(state, {
    type: "SELECT_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    versionIndex: 0,
    versionId: "version-a",
    preserveAbTestComparison: true,
  });
  assert.equal(state.conversations[0].turns[0].activeVersion, 0);
  assert.equal(state.conversations[0].turns[0].versions[0].assistant.abTestComparison?.status, "pending");

  state = conversationReducer(state, {
    type: "SELECT_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    versionIndex: 1,
    versionId: "version-b",
  });
  assert.equal(state.conversations[0].turns[0].activeVersion, 1);
  assert.equal(state.conversations[0].turns[0].versions[0].assistant.abTestComparison, undefined);
  assert.equal(state.conversations[0].turns[0].versions[1].assistant.abTestComparison, undefined);
});
