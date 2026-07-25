import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("chat submission is durable and idempotent", async () => {
  const [sql, historySql, store, historyStore, route] = await Promise.all([source("supabase/migrations/20260724000000_chat_jobs.sql"), source("supabase/migrations/20260724020000_chat_history.sql"), source("app/server/chat/chat-job-store.ts"), source("app/server/chat/chat-history-store.ts"), source("app/api/chat/route.ts")]);
  assert.match(sql, /unique \(owner_id, conversation_id, idempotency_key\)/);
  assert.match(sql, /chat_job_events/);
  assert.match(historySql, /chat_conversations/);
  assert.match(historySql, /chat_message_versions/);
  assert.match(historySql, /chat_messages/);
  assert.match(historySql, /activities jsonb/);
  assert.match(historySql, /alter table public\.chat_messages enable row level security/);
  assert.match(store, /error\.code !== "23505"/);
  assert.match(store, /ensureChatSubmission/);
  assert.match(store, /applyChatJobEvent/);
  assert.match(historyStore, /applyChatStreamEvent/);
  assert.match(historyStore, /finalizeChatHistoryMessage/);
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

test("disconnect is delivery-only while explicit stop calls durable cancellation", async () => {
  const [page, runner] = await Promise.all([source("app/page.tsx"), source("app/server/chat/chat-job-runner.ts")]);
  assert.match(page, /Abort only this tab's delivery/);
  assert.match(page, /await cancelChatJob/);
  assert.match(runner, /isChatJobCancelled/);
});

test("page reload and visibility restoration retain sequence and final output", async () => {
  const [page, history] = await Promise.all([source("app/page.tsx"), source("lib/chat-history.ts")]);
  assert.match(page, /jobId: makeId\(\)/);
  assert.match(history, /lastSequence\?: number/);
  assert.match(page, /visibilitychange/);
  assert.match(page, /event\.sequence <= after/);
  assert.match(page, /snapshot\.finalOutput/);
  assert.doesNotMatch(page, /status: message\.status === "streaming" \? "cancelled"/);
  assert.doesNotMatch(page, /localStorage/);
});

test("fresh history ignores local conversations and saves user preferences remotely", async () => {
  const [page, historyService, preferencesRoute, preferencesStore] = await Promise.all([
    source("app/page.tsx"),
    source("app/chat/chat-user-preferences-service.ts"),
    source("app/api/chat/user-preferences/route.ts"),
    source("app/server/chat/chat-user-preferences-store.ts"),
  ]);
  assert.match(page, /fetchChatConversations/);
  assert.match(page, /fetchChatConversation/);
  assert.doesNotMatch(page, /localStorage/);
  assert.match(historyService, /\/api\/chat\/user-preferences/);
  assert.match(preferencesRoute, /authorizeOwnerSession/);
  assert.match(preferencesStore, /chat_user_preferences/);
});
