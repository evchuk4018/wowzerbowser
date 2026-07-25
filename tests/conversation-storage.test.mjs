import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSettings,
  migrateConversation,
  normalizeConversation,
  normalizeStoredMessage,
} from "../app/chat/conversation-storage.ts";

test("malformed stored messages are rejected without throwing", () => {
  assert.equal(normalizeStoredMessage(null), null);
  assert.equal(normalizeStoredMessage({ role: "assistant", id: "", content: "x" }), null);
  assert.equal(normalizeStoredMessage({ role: "assistant", id: "m1", content: 42 }), null);

  const normalized = normalizeStoredMessage({ role: "user", id: "m2", content: "hello", activities: "bad" });
  assert.deepEqual(normalized, { role: "user", id: "m2", content: "hello" });
});

test("legacy alternating messages migrate into versioned turns", () => {
  const migrated = migrateConversation({
    id: "legacy-1",
    title: "Legacy",
    messages: [
      { role: "user", id: "u1", content: "hello" },
      {
        role: "assistant",
        id: "a1",
        content: "world",
        activities: [{
          id: "reason-1",
          kind: "reasoning",
          round: 1,
          content: "thinking",
          status: "running",
          startedAt: Date.now() - 100,
        }],
      },
      { role: "user", id: "u2", content: "unpaired" },
    ],
  });

  assert.ok(migrated);
  assert.equal(migrated.turns.length, 1);
  assert.equal(migrated.turns[0].activeVersion, 0);
  assert.equal(migrated.turns[0].versions[0].user.content, "hello");
  assert.equal(migrated.turns[0].versions[0].assistant.activities?.[0].status, "complete");
});

test("malformed turns are skipped while valid remote history remains usable", () => {
  const normalized = normalizeConversation({
    id: "conversation-1",
    title: "Chat",
    turns: [
      { id: "broken", versions: [{ id: "v", user: null, assistant: null }], activeVersion: 0 },
      {
        id: "turn-1",
        versions: [{
          id: "version-1",
          user: { id: "u", role: "user", content: "prompt" },
          assistant: { id: "a", role: "assistant", content: "answer", status: "complete" },
        }],
        activeVersion: 9,
      },
    ],
  }, { freezeRunningActivities: false });

  assert.deepEqual(normalized?.turns.map(({ id }) => id), ["turn-1"]);
  assert.equal(normalized?.turns[0].activeVersion, 0);
});

test("settings loading falls back to canonical defaults when remote storage fails", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const settings = await loadSettings("token");
    assert.equal(settings.userPresence, "");
    assert.match(settings.systemPrompt, /<bobert_behavior>/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

