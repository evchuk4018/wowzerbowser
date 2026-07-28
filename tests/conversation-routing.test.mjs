import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConversation, makeId } from "../app/chat/conversation-defaults.ts";
import { conversationReducer, initialConversationState } from "../app/chat/conversation-reducer.ts";
import { loadConversations } from "../app/chat/conversation-storage.ts";
import {
  mergeRequestedConversation,
  resolveConversationRoute,
} from "../app/chat/conversation-routing.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const conversation = (id, turns = []) => ({ id, title: "Chat", turns });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("conversation ids are UUIDs", () => {
  assert.match(makeId(), uuidPattern);
  assert.match(createConversation().id, uuidPattern);
});

test("LOAD_CONVERSATIONS selects a matching initial conversation and safely falls back", () => {
  const conversations = [conversation("first"), conversation("requested")];
  const selected = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations,
    activeId: "requested",
  });
  assert.equal(selected.activeId, "requested");

  const fallback = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations,
    activeId: "missing",
  });
  assert.equal(fallback.activeId, "first");
});

test("chat routes keep the workspace in a persistent layout", async () => {
  const [root, layout, index, page, workspace] = await Promise.all([
    source("app/page.tsx"),
    source("app/chat/layout.tsx"),
    source("app/chat/page.tsx"),
    source("app/chat/[conversationId]/page.tsx"),
    source("app/chat/chat-workspace.tsx"),
  ]);
  assert.match(root, /redirect\("\/chat"\)/);
  assert.match(layout, /<ChatPage \/>/);
  assert.match(index, /return null/);
  assert.match(page, /return null/);
  assert.match(workspace, /useParams/);
  assert.match(workspace, /handledRouteRef\.current === requestedConversationId/);
  assert.match(workspace, /router\.push\(`\/chat\/\$\{conversationId\}`\)/);
  assert.match(workspace, /router\.push\(`\/chat\/\$\{conversation\.id\}`\)/);
  assert.match(workspace, /router\.replace\(`\/chat\/\$\{replacement\.id\}`\)/);
});

test("new chat with existing history stays local and active", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const blank = createConversation();
  const state = conversationReducer(
    conversationReducer(initialConversationState, {
      type: "LOAD_CONVERSATIONS",
      conversations: [existing],
      activeId: existing.id,
    }),
    { type: "CREATE_CONVERSATION", conversation: blank },
  );

  assert.equal(state.activeId, blank.id);
  assert.equal(state.conversations[0].id, blank.id);
  assert.deepEqual(resolveConversationRoute(state, blank.id), { type: "none" });
  assert.equal(resolveConversationRoute(state, existing.id).type, "select");
});

test("a direct valid blank route is merged ahead of existing history", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const requestedId = "2e6f4a5d-8c7b-4b6a-9d0e-1f2a3b4c5d6e";
  const conversations = mergeRequestedConversation({
    conversations: [existing],
    streamingByConversation: {},
  }, requestedId);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations,
    activeId: requestedId,
  });

  assert.deepEqual(conversations.map(({ id }) => id), [requestedId, existing.id]);
  assert.equal(state.activeId, requestedId);
  assert.equal(state.conversations[0].turns.length, 0);
  assert.deepEqual(resolveConversationRoute(state, requestedId), { type: "none" });
});

test("an existing conversation route selects the requested transcript", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const requested = conversation("7abf1c2d-3e4f-4567-8a9b-0c1d2e3f4a5b", [{}]);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [existing, requested],
    activeId: existing.id,
  });

  assert.deepEqual(resolveConversationRoute(state, requested.id), {
    type: "select",
    conversationId: requested.id,
  });
  const selected = conversationReducer(state, {
    type: "SELECT_CONVERSATION",
    conversationId: requested.id,
  });
  assert.equal(selected.activeId, requested.id);
});

test("an invalid conversation route redirects without creating an invalid chat", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [existing],
    activeId: existing.id,
  });

  assert.deepEqual(resolveConversationRoute(state, "not-a-valid-id"), {
    type: "redirect",
    conversationId: existing.id,
  });
  assert.equal(state.conversations.some(({ id }) => id === "not-a-valid-id"), false);
});

test("blank routed conversations remain client-only until submission", async () => {
  const [workspace, history] = await Promise.all([
    source("app/chat/chat-workspace.tsx"),
    source("app/server/chat/chat-history-store.ts"),
  ]);
  assert.match(workspace, /mergeRequestedConversation/);
  assert.match(history, /export async function ensureChatSubmission/);
  assert.match(history, /insertIfAbsent\("chat_conversations"/);
});

test("loading a persisted conversation restores its transcript for a refresh", async () => {
  const previousFetch = globalThis.fetch;
  const conversationId = "67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd";
  const persisted = {
    id: conversationId,
    title: "Persisted chat",
    turns: [{
      id: "turn-1",
      activeVersion: 0,
      versions: [{
        id: "version-1",
        user: { id: "user-1", role: "user", content: "hello" },
        assistant: { id: "assistant-1", role: "assistant", content: "world", status: "complete" },
      }],
    }],
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/chat/conversations") {
      return Response.json({ conversations: [{ id: conversationId, isStreaming: false }] });
    }
    assert.equal(url, `/api/chat/conversations/${conversationId}`);
    return Response.json({ conversation: persisted });
  };
  try {
    const loaded = await loadConversations("token");
    assert.equal(loaded.conversations[0].id, conversationId);
    assert.equal(loaded.conversations[0].turns[0].versions[0].assistant.content, "world");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
