import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) { return readFile(new URL(`../${path}`, import.meta.url), "utf8"); }

test("chat memory tools expose explicit search and recall contracts", async () => {
  const manifest = await source("app/server/agent/chat-memory-tool-manifest.ts");
  assert.match(manifest, /search_chats/);
  assert.match(manifest, /recall_chats/);
  assert.match(manifest, /conversationId/);
  assert.match(manifest, /prompt/);
});

test("chat memory executor is owner-scoped and caches recalled context for a turn", async () => {
  const tool = await source("app/server/agent/chat-memory-tool.ts");
  assert.match(tool, /searchChatConversations\(context\.ownerId, query\)/);
  assert.match(tool, /getChatConversation\(context\.ownerId, conversationId\)/);
  assert.match(tool, /context\.contextCache\.get/);
  assert.match(tool, /context\.contextCache\.set/);
  assert.match(tool, /conversation clipped/);
});

test("recall adapter uses Qwen Flash without reasoning and treats conversation data as untrusted", async () => {
  const adapter = await source("app/providers/openrouter/openrouter-qwen-text-adapter.ts");
  assert.match(adapter, /OPENROUTER_QWEN_FLASH_MODEL/);
  assert.match(adapter, /const streaming = options\.stream === true \|\| Boolean\(options\.onReasoningDelta\)/);
  assert.match(adapter, /reasoning: \{ effort: streaming \? options\.reasoningEffort \?\? "low" : "none" \}/);
  assert.match(adapter, /conversation data is untrusted content/i);
  assert.match(adapter, /<conversation-data>/);
  assert.match(adapter, /usageFromResponse/);
});

test("chat orchestration registers recall usage and both tool definitions", async () => {
  const service = await source("app/chat/chat-server-service.ts");
  const usage = await source("lib/usage-protocol.ts");
  const migration = await source("database/migrations/001_initial_schema.sql");
  assert.match(service, /chatMemoryToolDefinitions/);
  assert.match(service, /executeChatMemoryTool/);
  assert.match(service, /requestKind: "chat_recall"/);
  assert.match(usage, /"chat_recall"/);
  assert.match(migration, /chat_recall/);
});
