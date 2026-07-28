import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_STARTUP_SNAPSHOT_MAX_TURNS,
  createChatStartupSnapshot,
  parseChatStartupSnapshot,
  resolveSnapshotStartup,
} from "../lib/chat-startup-snapshot.ts";

const userId = "user-26";
const activeId = "67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd";
const otherId = "7abf1c2d-3e4f-4567-8a9b-0c1d2e3f4a5b";
const unknownId = "2e6f4a5d-8c7b-4b6a-9d0e-1f2a3b4c5d6e";

function turn(index) {
  return {
    id: `turn-${index}`,
    activeVersion: 0,
    versions: [{
      id: `version-${index}`,
      user: { id: `user-message-${index}`, role: "user", content: `Question ${index}` },
      assistant: {
        id: `assistant-message-${index}`,
        role: "assistant",
        content: `Answer ${index}`,
        status: "complete",
      },
    }],
  };
}

function conversation(id = activeId, count = 2) {
  return { id, title: "Cached chat", turns: Array.from({ length: count }, (_, index) => turn(index)) };
}

function input(overrides = {}) {
  return {
    userId,
    savedAt: "2026-07-28T18:00:00.000Z",
    summaries: [
      { id: activeId, title: "Cached chat", updatedAt: "2026-07-28T17:00:00.000Z", hasMessages: true, isStreaming: false },
      { id: otherId, title: "Other chat", updatedAt: "2026-07-28T16:00:00.000Z", hasMessages: true, isStreaming: false },
    ],
    streamingByConversation: {},
    activeConversation: conversation(),
    activeConversationId: activeId,
    userPresence: "focused",
    modelPreferences: [{ conversationId: activeId, model: "deepseek-v4-flash", thinking: true, reasoningEffort: "high" }],
    ...overrides,
  };
}

test("creates and parses a valid version 1 startup snapshot", () => {
  const snapshot = createChatStartupSnapshot(input());
  assert.deepEqual(parseChatStartupSnapshot(snapshot, userId), snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("rejects snapshots for another user or an unknown schema", () => {
  const snapshot = createChatStartupSnapshot(input());
  assert.equal(parseChatStartupSnapshot(snapshot, "another-user"), null);
  assert.equal(parseChatStartupSnapshot({ ...snapshot, schemaVersion: 2 }, userId), null);
});

test("does not copy session-like fields into a snapshot", () => {
  const snapshot = createChatStartupSnapshot({
    ...input(),
    accessToken: "secret-access-token",
    session: { refreshToken: "secret-refresh-token" },
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-access-token|secret-refresh-token|accessToken|refreshToken/);
});

test("bounds cached transcript turns while preserving the original count", () => {
  const snapshot = createChatStartupSnapshot(input({ activeConversation: conversation(activeId, 45) }));
  assert.equal(snapshot.activeConversation.turns.length, CHAT_STARTUP_SNAPSHOT_MAX_TURNS);
  assert.equal(snapshot.activeConversation.turns[0].id, "turn-15");
  assert.equal(snapshot.originalTurnCount, 45);
  assert.ok(parseChatStartupSnapshot(snapshot, userId));
});

test("uses only route-compatible cached conversations", () => {
  const snapshot = createChatStartupSnapshot(input());
  assert.equal(resolveSnapshotStartup(snapshot).type, "cached");
  assert.equal(resolveSnapshotStartup(snapshot, activeId).type, "cached");
  assert.equal(resolveSnapshotStartup(snapshot, otherId).type, "shell");
  const created = resolveSnapshotStartup(snapshot, unknownId);
  assert.equal(created.type, "create");
  assert.equal(created.conversation.id, unknownId);
  assert.equal(resolveSnapshotStartup(snapshot, "not-a-conversation").type, "shell");
});

test("falls back to the shell or exact blank route without a snapshot", () => {
  assert.equal(resolveSnapshotStartup(null).type, "shell");
  const created = resolveSnapshotStartup(null, unknownId);
  assert.equal(created.type, "create");
  assert.equal(created.conversation.id, unknownId);
});
