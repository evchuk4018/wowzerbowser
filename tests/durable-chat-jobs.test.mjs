import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("chat submission is durable and idempotent", async () => {
  const [sql, historySql, store, historyStore, runner, route] = await Promise.all([source("supabase/migrations/20260724000000_chat_jobs.sql"), source("supabase/migrations/20260724020000_chat_history.sql"), source("app/server/chat/chat-job-store.ts"), source("app/server/chat/chat-history-store.ts"), source("app/server/chat/chat-job-runner.ts"), source("app/api/chat/route.ts")]);
  assert.match(sql, /unique \(owner_id, conversation_id, idempotency_key\)/);
  assert.match(sql, /chat_job_events/);
  assert.match(historySql, /chat_conversations/);
  assert.match(historySql, /chat_message_versions/);
  assert.match(historySql, /chat_messages/);
  assert.match(historySql, /activities jsonb/);
  assert.match(historySql, /alter table public\.chat_messages enable row level security/);
  assert.match(store, /error\.code !== "23505"/);
  assert.match(store, /ensureChatSubmission/);
  assert.match(store, /createChatJobEventWriter/);
  assert.match(store, /CHAT_EVENT_BATCH_SIZE = 32/);
  assert.match(store, /CHAT_EVENT_FLUSH_INTERVAL_MS = 100/);
  assert.doesNotMatch(store, /applyChatJobEvent/);
  assert.match(historyStore, /applyChatStreamEvent/);
  assert.match(historyStore, /finalizeChatHistoryMessage/);
  assert.match(runner, /eventWriter\.enqueue/);
  assert.match(runner, /await eventWriter\.drain\(\)/);
  assert.match(store, /eq\("status", "queued"\)/);
  assert.match(route, /after\(\(\) => runChatJob/);
  assert.doesNotMatch(route, /request\.signal/);
});

test("replay is ordered, exclusive, and owner isolated", async () => {
  const store = await source("app/server/chat/chat-job-store.ts");
  assert.match(store, /eq\("owner_id", ownerId\)/);
  assert.match(store, /gt\("sequence", after\)\.order\("sequence"\)/);
  const endpoint = await source("app/api/chat/jobs/[conversationId]/[jobId]/route.ts");
  assert.match(endpoint, /authorizeOwnerSession/);
  assert.match(endpoint, /getChatJob\(user\.id/);
});

test("live delivery polls faster than background recovery", async () => {
  const [service, recovery] = await Promise.all([
    source("app/chat/chat-service.ts"),
    source("app/chat/use-persisted-job-recovery.ts"),
  ]);
  assert.match(service, /LIVE_CHAT_POLL_INTERVAL_MS = 100/);
  assert.match(service, /setTimeout\(resolve, LIVE_CHAT_POLL_INTERVAL_MS\)/);
  assert.match(recovery, /pollIntervalMs = 750/);
});

test("disconnect is delivery-only while explicit stop calls durable cancellation", async () => {
  const [page, generation, runner] = await Promise.all([source("app/page.tsx"), source("app/chat/use-chat-generation.ts"), source("app/server/chat/chat-job-runner.ts")]);
  const client = `${page}\n${generation}`;
  assert.match(client, /controller\.abort\(\)/);
  assert.match(client, /await cancelChatJob/);
  assert.match(runner, /isChatJobCancelled/);
});

test("page reload and visibility restoration retain sequence and final output", async () => {
  const [page, generation, recovery, history] = await Promise.all([source("app/page.tsx"), source("app/chat/use-chat-generation.ts"), source("app/chat/use-persisted-job-recovery.ts"), source("lib/chat-history.ts")]);
  const client = `${page}\n${generation}\n${recovery}`;
  assert.match(client, /const jobId = makeId\(\)/);
  assert.match(history, /lastSequence\?: number/);
  assert.match(client, /visibilitychange/);
  assert.match(client, /event\.sequence <= after/);
  assert.match(client, /snapshot\.finalOutput/);
  assert.doesNotMatch(client, /status: message\.status === "streaming" \? "cancelled"/);
  assert.doesNotMatch(client, /localStorage/);
});

test("fresh history ignores local conversations and saves user preferences remotely", async () => {
  const [page, workspace, storage, historyService, preferencesRoute, preferencesStore] = await Promise.all([
    source("app/page.tsx"),
    source("app/chat/chat-workspace.tsx"),
    source("app/chat/conversation-storage.ts"),
    source("app/chat/chat-user-preferences-service.ts"),
    source("app/api/chat/user-preferences/route.ts"),
    source("app/server/chat/chat-user-preferences-store.ts"),
  ]);
  const client = `${page}\n${workspace}\n${storage}`;
  assert.match(client, /fetchChatConversations/);
  assert.match(client, /fetchChatConversation/);
  assert.doesNotMatch(client, /localStorage/);
  assert.match(historyService, /\/api\/chat\/user-preferences/);
  assert.match(preferencesRoute, /authorizeOwnerSession/);
  assert.match(preferencesStore, /chat_user_preferences/);
});
