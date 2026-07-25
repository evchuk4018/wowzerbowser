import assert from "node:assert/strict";
import test from "node:test";
import { conversationReducer, initialConversationState } from "../app/chat/conversation-reducer.ts";

const message = (id, role, content, status = role === "assistant" ? "complete" : undefined) => ({
  id,
  role,
  content,
  ...(status ? { status } : {}),
});

const version = (id, prompt = "hello", answer = "world") => ({
  id,
  user: message(`${id}-user`, "user", prompt),
  assistant: message(`${id}-assistant`, "assistant", answer),
});

const conversation = (id = "conversation-1") => ({
  id,
  title: "New conversation",
  turns: [{ id: "turn-1", versions: [version("version-1")], activeVersion: 0 }],
});

const loaded = () => conversationReducer(initialConversationState, {
  type: "LOAD_CONVERSATIONS",
  conversations: [conversation()],
});

test("loads, creates, selects, and titles conversations with stable ordering", () => {
  const first = loaded();
  assert.equal(first.activeId, "conversation-1");

  const secondConversation = conversation("conversation-2");
  const created = conversationReducer(first, {
    type: "CREATE_CONVERSATION",
    conversation: secondConversation,
  });
  assert.deepEqual(created.conversations.map(({ id }) => id), ["conversation-2", "conversation-1"]);
  assert.equal(created.activeId, "conversation-2");
  assert.notEqual(created.conversations, first.conversations);

  const selected = conversationReducer(created, {
    type: "SELECT_CONVERSATION",
    conversationId: "conversation-1",
  });
  assert.equal(selected.activeId, "conversation-1");
  const titled = conversationReducer(selected, {
    type: "UPDATE_TITLE",
    conversationId: "conversation-1",
    title: "Renamed",
  });
  assert.equal(titled.conversations[1].title, "Renamed");
});

test("updates messages immutably and marks terminal statuses", () => {
  const state = loaded();
  const assistantId = "version-1-assistant";
  const updated = conversationReducer(state, {
    type: "UPDATE_MESSAGE",
    conversationId: "conversation-1",
    messageId: assistantId,
    patch: { content: "partial", reasoning: "thinking" },
  });
  const oldVersion = state.conversations[0].turns[0].versions[0];
  const newVersion = updated.conversations[0].turns[0].versions[0];
  assert.equal(oldVersion.assistant.content, "world");
  assert.equal(newVersion.assistant.content, "partial");
  assert.equal(newVersion.assistant.reasoning, "thinking");
  assert.notEqual(newVersion, oldVersion);
  assert.notEqual(updated.conversations[0], state.conversations[0]);

  const complete = conversationReducer(updated, {
    type: "MARK_MESSAGE_COMPLETE",
    conversationId: "conversation-1",
    messageId: assistantId,
    finalOutput: "done",
  });
  assert.equal(complete.conversations[0].turns[0].versions[0].assistant.status, "complete");
  assert.equal(complete.conversations[0].turns[0].versions[0].assistant.content, "done");

  const errored = conversationReducer(complete, {
    type: "MARK_MESSAGE_ERROR",
    conversationId: "conversation-1",
    messageId: assistantId,
    error: "network",
  });
  assert.equal(errored.conversations[0].turns[0].versions[0].assistant.status, "error");
  assert.equal(errored.conversations[0].turns[0].versions[0].assistant.error, "network");

  const cancelled = conversationReducer(errored, {
    type: "MARK_MESSAGE_CANCELLED",
    conversationId: "conversation-1",
    messageId: assistantId,
  });
  assert.equal(cancelled.conversations[0].turns[0].versions[0].assistant.status, "cancelled");
});

test("appends edited prompt versions and selects a clamped version", () => {
  const state = loaded();
  const edited = version("version-2", "edited prompt", "new response");
  const appended = conversationReducer(state, {
    type: "APPEND_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    version: edited,
  });
  const turn = appended.conversations[0].turns[0];
  assert.equal(turn.versions.length, 2);
  assert.equal(turn.activeVersion, 1);

  const selected = conversationReducer(appended, {
    type: "SELECT_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    versionIndex: -10,
  });
  assert.equal(selected.conversations[0].turns[0].activeVersion, 0);
  const selectedLast = conversationReducer(selected, {
    type: "SELECT_TURN_VERSION",
    conversationId: "conversation-1",
    turnId: "turn-1",
    versionIndex: 99,
  });
  assert.equal(selectedLast.conversations[0].turns[0].activeVersion, 1);
});

test("appends a new turn without changing the selected conversation", () => {
  const state = loaded();
  const nextTurn = { id: "turn-2", versions: [version("version-2")], activeVersion: 0 };
  const next = conversationReducer(state, {
    type: "APPEND_TURN",
    conversationId: "conversation-1",
    turn: nextTurn,
  });
  assert.equal(next.activeId, state.activeId);
  assert.deepEqual(next.conversations[0].turns.map(({ id }) => id), ["turn-1", "turn-2"]);
});

test("removes conversations and replaces an active chat with a blank conversation", () => {
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [conversation("conversation-1"), conversation("conversation-2")],
  });
  const replacement = { id: "conversation-blank", title: "New conversation", turns: [] };
  const removed = conversationReducer(state, {
    type: "REMOVE_CONVERSATION",
    conversationId: "conversation-1",
    replacement,
  });

  assert.equal(removed.activeId, "conversation-blank");
  assert.deepEqual(removed.conversations.map(({ id }) => id), ["conversation-blank", "conversation-2"]);
  assert.equal(removed.conversations[0].turns.length, 0);
});

test("removes a non-active conversation without changing the active chat", () => {
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [conversation("conversation-1"), conversation("conversation-2")],
  });
  const selected = conversationReducer(state, {
    type: "SELECT_CONVERSATION",
    conversationId: "conversation-2",
  });
  const removed = conversationReducer(selected, {
    type: "REMOVE_CONVERSATION",
    conversationId: "conversation-1",
  });

  assert.equal(removed.activeId, "conversation-2");
  assert.deepEqual(removed.conversations.map(({ id }) => id), ["conversation-2"]);
});
