import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConversation, makeId } from "../app/chat/conversation-defaults.ts";
import { conversationReducer, initialConversationState } from "../app/chat/conversation-reducer.ts";
import { loadConversations } from "../app/chat/conversation-storage.ts";

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

test("chat routes pass the URL id and synchronize browser history", async () => {
  const [page, workspace] = await Promise.all([
    source("app/chat/[conversationId]/page.tsx"),
    source("app/chat/chat-workspace.tsx"),
  ]);
  assert.match(page, /initialConversationId=\{conversationId\}/);
  assert.match(workspace, /initialConversationId\?: string/);
  assert.match(workspace, /router\.push\(`\/chat\/\$\{conversationId\}`\)/);
  assert.match(workspace, /router\.push\(`\/chat\/\$\{conversation\.id\}`\)/);
  assert.match(workspace, /router\.replace\(`\/chat\/\$\{replacement\.id\}`\)/);
});

test("blank routed conversations remain client-only until submission", async () => {
  const [workspace, history] = await Promise.all([
    source("app/chat/chat-workspace.tsx"),
    source("app/server/chat/chat-history-store.ts"),
  ]);
  assert.match(workspace, /requestedBlank/);
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
