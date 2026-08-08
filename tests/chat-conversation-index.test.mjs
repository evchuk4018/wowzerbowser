import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapChatConversationSummaryRows } from "../app/server/chat/chat-history-store.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("conversation index RPC computes message flags with indexed exists checks", async () => {
  const [schema, migration] = await Promise.all([
    source("database/migrations/001_initial_schema.sql"),
    source("database/migrations/016_chat_projects.sql"),
  ]);

  assert.match(migration, /create function public\.list_chat_conversations_fast\(/);
  assert.match(migration, /p_owner_id uuid/);
  assert.match(migration, /exists\(select 1 from public\.chat_messages/);
  assert.match(migration, /m\.owner_id=c\.owner_id/);
  assert.match(migration, /m\.conversation_id=c\.conversation_id/);
  assert.match(migration, /m\.role='assistant'/);
  assert.match(migration, /m\.status='streaming'/);
  assert.match(migration, /order by c\.updated_at desc/);
  assert.match(schema, /create index if not exists chat_messages_streaming_conversation/);
  assert.match(schema, /on public\.chat_messages\(owner_id, conversation_id\)/);
  assert.match(schema, /where role = 'assistant' and status = 'streaming'/);
});

test("conversation listing uses one local database function and avoids an owner-wide message scan", async () => {
  const history = await source("app/server/chat/chat-history-store.ts");

  assert.match(history, /list_chat_conversations_fast/);
  assert.match(history, /databaseOwnerId\(ownerId\)/);
  assert.doesNotMatch(history, /from\("chat_messages"\)\.select\("conversation_id,role,status"\)/);
  assert.doesNotMatch(history, /messagesByConversation/);
});

test("conversation index rows preserve database ordering and map empty, populated, and streaming states", () => {
  const rows = [
    {
      conversation_id: "newest",
      title: "Newest",
      updated_at: "2026-07-28T12:00:00.000Z",
      has_messages: true,
      is_streaming: false,
    },
    {
      conversation_id: "older",
      title: "Older",
      updated_at: "2026-07-28T11:00:00.000Z",
      has_messages: true,
      is_streaming: true,
    },
    {
      conversation_id: "empty",
      title: "Empty",
      updated_at: "2026-07-28T10:00:00.000Z",
      has_messages: false,
      is_streaming: false,
    },
  ];

  assert.deepEqual(mapChatConversationSummaryRows(rows), [
    { id: "newest", title: "Newest", updatedAt: "2026-07-28T12:00:00.000Z", hasMessages: true, isStreaming: false },
    { id: "older", title: "Older", updatedAt: "2026-07-28T11:00:00.000Z", hasMessages: true, isStreaming: true },
    { id: "empty", title: "Empty", updatedAt: "2026-07-28T10:00:00.000Z", hasMessages: false, isStreaming: false },
  ]);
  assert.deepEqual(mapChatConversationSummaryRows([]), []);
});
