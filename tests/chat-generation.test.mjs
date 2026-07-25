import assert from "node:assert/strict";
import test from "node:test";
import { buildChatGenerationRequest } from "../app/chat/use-chat-generation.ts";

const conversation = {
  id: "conversation-1",
  title: "Chat",
  turns: [
    {
      id: "turn-1",
      activeVersion: 0,
      versions: [{
        id: "version-1",
        user: { id: "u1", role: "user", content: "first" },
        assistant: { id: "a1", role: "assistant", content: "reply", status: "complete" },
      }],
    },
  ],
};

const settings = { systemPrompt: "system", userPresence: "present" };

test("generation request preserves durable ids and active history", () => {
  const request = buildChatGenerationRequest({
    conversation,
    content: "next",
    editingTurnIndex: -1,
    turnId: "turn-2",
    versionId: "version-2",
    userMessageId: "u2",
    assistantMessageId: "a2",
    jobId: "job-2",
    settings,
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "high",
  });

  assert.deepEqual(request.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "next" },
  ]);
  assert.equal(request.conversationId, "conversation-1");
  assert.equal(request.jobId, "job-2");
  assert.equal(request.idempotencyKey, "job-2");
  assert.deepEqual(request.persistence, {
    turnId: "turn-2",
    versionId: "version-2",
    userMessageId: "u2",
    assistantMessageId: "a2",
    turnIndex: 1,
    versionIndex: 0,
  });
});

test("editing a prompt truncates context and increments version index", () => {
  const request = buildChatGenerationRequest({
    conversation,
    content: "revised",
    editingTurnIndex: 0,
    turnId: "turn-1",
    versionId: "version-2",
    userMessageId: "u2",
    assistantMessageId: "a2",
    jobId: "job-3",
    settings,
    model: "deepseek-v4-pro",
    thinking: false,
    reasoningEffort: "max",
  });

  assert.deepEqual(request.messages, [{ role: "user", content: "revised" }]);
  assert.equal(request.persistence.turnIndex, 0);
  assert.equal(request.persistence.versionIndex, 1);
  assert.equal(request.thinking, false);
});

