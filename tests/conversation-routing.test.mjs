import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConversation, makeId } from "../app/chat/conversation-defaults.ts";
import { conversationReducer, initialConversationState } from "../app/chat/conversation-reducer.ts";
import {
  loadConversation,
  loadConversationIndex,
} from "../app/chat/conversation-storage.ts";
import { resolveConversationRoute } from "../app/chat/conversation-routing.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const conversation = (id, turns = []) => ({ id, title: "Chat", turns });
const summary = (id, overrides = {}) => ({
  id,
  title: `Chat ${id}`,
  updatedAt: "2026-07-28T12:00:00.000Z",
  hasMessages: true,
  isStreaming: false,
  ...overrides,
});
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

test("the base chat route creates a fresh blank conversation", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [existing],
    activeId: existing.id,
  });

  const resolution = resolveConversationRoute(state);
  assert.equal(resolution.type, "create");
  assert.equal(resolution.conversation.turns.length, 0);
  assert.notEqual(resolution.conversation.id, existing.id);
});

test("a known but unhydrated direct-link route requests one transcript", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd");
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [existing],
    activeId: existing.id,
  });
  const requestedId = "7abf1c2d-3e4f-4567-8a9b-0c1d2e3f4a5b";

  assert.deepEqual(resolveConversationRoute(state, requestedId, new Set([requestedId])), {
    type: "load",
    conversationId: requestedId,
  });
});

test("HYDRATE_CONVERSATION inserts and selects a transcript", () => {
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [conversation("local")],
  });
  const hydrated = conversation("persisted", [{}]);
  const next = conversationReducer(state, {
    type: "HYDRATE_CONVERSATION",
    conversation: hydrated,
    select: true,
  });

  assert.equal(next.activeId, hydrated.id);
  assert.deepEqual(next.conversations.map(({ id }) => id), [hydrated.id, "local"]);
});

test("HYDRATE_CONVERSATION replaces an existing transcript without duplicates", () => {
  const original = conversation("persisted", [{}]);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [original],
    activeId: original.id,
  });
  const hydrated = conversation(original.id, [{ id: "new-turn" }]);
  const next = conversationReducer(state, {
    type: "HYDRATE_CONVERSATION",
    conversation: hydrated,
  });

  assert.equal(next.conversations.length, 1);
  assert.equal(next.conversations[0], hydrated);
  assert.equal(next.activeId, original.id);
});

test("a hydrated conversation route selects without requesting another transcript", () => {
  const hydrated = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd", [{}]);
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [conversation("other"), hydrated],
    activeId: "other",
  });

  assert.deepEqual(resolveConversationRoute(state, hydrated.id), {
    type: "select",
    conversationId: hydrated.id,
  });
});

test("a valid unknown UUID still creates a local blank conversation", () => {
  const existing = conversation("67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd");
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [existing],
    activeId: existing.id,
  });
  const requestedId = "2e6f4a5d-8c7b-4b6a-9d0e-1f2a3b4c5d6e";
  const resolution = resolveConversationRoute(state, requestedId);

  assert.equal(resolution.type, "create");
  assert.equal(resolution.conversation.id, requestedId);
  assert.equal(resolution.conversation.turns.length, 0);
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
  assert.doesNotMatch(workspace, /mergeRequestedConversation/);
  assert.match(workspace, /type: "CREATE_CONVERSATION"/);
  assert.match(history, /export async function ensureChatSubmission/);
  assert.match(history, /insertIfAbsent\("chat_conversations"/);
});

test("loadConversationIndex calls only the conversations endpoint", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ conversations: [summary("one")] });
  };
  try {
    const index = await loadConversationIndex("token");
    assert.deepEqual(index.summaries, [summary("one")]);
    assert.deepEqual(calls, ["/api/chat/conversations"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("loading an index with 20 summaries makes zero detail requests", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  const summaries = Array.from({ length: 20 }, (_, index) => summary(`conversation-${index}`));
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ conversations: summaries });
  };
  try {
    const index = await loadConversationIndex("token");
    assert.equal(index.summaries.length, 20);
    assert.equal(calls.filter((url) => url.includes("/api/chat/conversations/")).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("loadConversation fetches exactly one detail endpoint", async () => {
  const previousFetch = globalThis.fetch;
  const conversationId = "67bf57e2-fb3c-4f4c-a67f-cc9aeb1db3dd";
  const persisted = conversation(conversationId, [{
    id: "turn-1",
    activeVersion: 0,
    versions: [{
      id: "version-1",
      user: { id: "user-1", role: "user", content: "hello" },
      assistant: { id: "assistant-1", role: "assistant", content: "world", status: "complete" },
    }],
  }]);
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ conversation: persisted });
  };
  try {
    const loaded = await loadConversation(conversationId, "token");
    assert.equal(loaded.id, conversationId);
    assert.equal(loaded.turns[0].versions[0].assistant.content, "world");
    assert.deepEqual(calls, [`/api/chat/conversations/${conversationId}`]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("workspace caches hydrated conversations and ignores stale transcript responses", async () => {
  const workspace = await source("app/chat/chat-workspace.tsx");
  assert.match(workspace, /const cached = state\.conversations\.find/);
  assert.match(workspace, /type: "HYDRATE_CONVERSATION"/);
  assert.match(workspace, /const requestId = \+\+conversationLoadRequestRef\.current/);
  assert.match(workspace, /if \(requestId !== conversationLoadRequestRef\.current\) return/);
});

test("an unloaded conversation can be deleted from the sidebar", async () => {
  const workspace = await source("app/chat/chat-workspace.tsx");
  assert.match(workspace, /const wasActive = conversationId === state\.activeId/);
  assert.match(workspace, /setConversationSummaries\(\(current\) =>/);
  assert.match(workspace, /sidebarConversations\.find\(/);
  assert.doesNotMatch(workspace, /const conversation = state\.conversations\.find\(\(\{ id \}\) => id === conversationId\)/);
});

test("conversation storage no longer fetches every transcript", async () => {
  const storage = await source("app/chat/conversation-storage.ts");
  assert.doesNotMatch(
    storage,
    /Promise\.allSettled\(\s*summaries\.map/,
  );
});
