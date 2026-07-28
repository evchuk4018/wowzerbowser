import assert from "node:assert/strict";
import test from "node:test";
import {
  modelPreferencesRecord,
  parseChatBootstrapPayload,
  resolveChatBootstrapSelection,
  streamingMapFor,
} from "../lib/chat-bootstrap.ts";

const existingId = "67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd";
const unknownId = "2e6f4a5d-8c7b-4b6a-9d0e-1f2a3b4c5d6e";
const summaries = [
  {
    id: existingId,
    title: "Newest",
    updatedAt: "2026-07-28T12:00:00.000Z",
    hasMessages: true,
    isStreaming: true,
  },
  {
    id: "7abf1c2d-3e4f-4567-8a9b-0c1d2e3f4a5b",
    title: "Older",
    updatedAt: "2026-07-27T12:00:00.000Z",
    hasMessages: true,
    isStreaming: false,
  },
];

const basePayload = {
  user: { id: "user-1", email: "owner@example.com" },
  summaries,
  streamingByConversation: { [existingId]: "persisted" },
  activeConversation: null,
  activeConversationId: null,
  requestedConversationId: null,
  userPreferences: { userPresence: "focused" },
  modelPreferences: [],
};

test("bootstrap selects an existing requested conversation", () => {
  assert.deepEqual(resolveChatBootstrapSelection(summaries, existingId), {
    requestedConversationId: existingId,
    activeConversationId: existingId,
    loadConversationId: existingId,
  });
});

test("bootstrap selects the newest conversation for /chat", () => {
  assert.deepEqual(resolveChatBootstrapSelection(summaries), {
    requestedConversationId: null,
    activeConversationId: existingId,
    loadConversationId: existingId,
  });
});

test("bootstrap treats an invalid route like /chat", () => {
  assert.deepEqual(resolveChatBootstrapSelection(summaries, "not-a-uuid"), {
    requestedConversationId: null,
    activeConversationId: existingId,
    loadConversationId: existingId,
  });
});

test("bootstrap preserves a valid unknown UUID without selecting a remote conversation", () => {
  assert.deepEqual(resolveChatBootstrapSelection(summaries, unknownId), {
    requestedConversationId: unknownId,
    activeConversationId: null,
    loadConversationId: unknownId,
  });
});

test("bootstrap leaves an empty account without an active conversation", () => {
  assert.deepEqual(resolveChatBootstrapSelection([], unknownId), {
    requestedConversationId: unknownId,
    activeConversationId: null,
    loadConversationId: unknownId,
  });
  assert.deepEqual(resolveChatBootstrapSelection([]), {
    requestedConversationId: null,
    activeConversationId: null,
    loadConversationId: null,
  });
});

test("streaming summaries produce the persisted streaming map", () => {
  assert.deepEqual(streamingMapFor(summaries), { [existingId]: "persisted" });
});

test("bootstrap payload normalization rejects malformed payloads", () => {
  assert.throws(
    () => parseChatBootstrapPayload({ ...basePayload, summaries: "bad" }),
    /invalid chat bootstrap response/i,
  );
  assert.throws(
    () => parseChatBootstrapPayload({ ...basePayload, activeConversation: { id: "bad" } }),
    /invalid chat bootstrap response/i,
  );
});

test("model preference rows normalize into a record and skip malformed entries", () => {
  const parsed = parseChatBootstrapPayload({
    ...basePayload,
    modelPreferences: [
      {
        conversationId: existingId,
        model: "deepseek-v4-flash",
        thinking: true,
        reasoningEffort: "high",
      },
      { conversationId: "bad", model: "unknown", thinking: "yes" },
    ],
  });
  assert.deepEqual(modelPreferencesRecord(parsed.modelPreferences), {
    [existingId]: {
      model: { provider: "deepseek", model: "deepseek-v4-flash" },
      thinking: true,
      reasoningEffort: "high",
    },
  });
});
