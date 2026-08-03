import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("chat submission is durable, idempotent, and uses per-job event ordinals", async () => {
  const [sql, ordinalSql, atomicSql, historySql, lineageSql, store, historyStore, runner, route] = await Promise.all([source("supabase/migrations/20260724000000_chat_jobs.sql"), source("supabase/migrations/20260725000000_chat_event_ordinals.sql"), source("supabase/migrations/20260730190000_chat_leases_atomic_persistence.sql"), source("supabase/migrations/20260724020000_chat_history.sql"), source("supabase/migrations/20260728180000_chat_version_lineage.sql"), source("app/server/chat/chat-job-store.ts"), source("app/server/chat/chat-history-store.ts"), source("app/server/chat/chat-job-runner.ts"), source("app/api/chat/route.ts")]);
  assert.match(sql, /unique \(owner_id, conversation_id, idempotency_key\)/);
  assert.match(sql, /chat_job_events/);
  assert.match(ordinalSql, /event_index bigint/);
  assert.match(ordinalSql, /row_number\(\) over/);
  assert.match(ordinalSql, /chat_job_events_job_ordinal/);
  assert.match(ordinalSql, /assign_chat_job_event_index/);
  assert.match(ordinalSql, /update public\.chat_messages/);
  assert.match(ordinalSql, /events\.sequence <= messages\.last_sequence/);
  assert.match(ordinalSql, /translate_chat_message_event_checkpoint/);
  assert.match(historySql, /chat_conversations/);
  assert.match(historySql, /chat_message_versions/);
  assert.match(historySql, /chat_messages/);
  assert.match(lineageSql, /add column if not exists parent_version_id/i);
  assert.match(lineageSql, /parent_version_id = v_parent_version_id/);
  assert.match(historySql, /activities jsonb/);
  assert.match(historySql, /alter table public\.chat_messages enable row level security/);
  assert.match(store, /withChatPersistenceRetry/);
  assert.match(store, /authoritativeAttachmentsForSubmission/);
  assert.match(store, /createChatJobEventWriter/);
  assert.match(store, /CHAT_EVENT_BATCH_SIZE = 32/);
  assert.match(store, /CHAT_EVENT_FLUSH_INTERVAL_MS = 100/);
  assert.doesNotMatch(store, /applyChatJobEvent/);
  assert.match(historyStore, /applyChatStreamEvent/);
  assert.match(historyStore, /finalizeChatHistoryMessage/);
  assert.match(historyStore, /materializePersistedLineage/);
  assert.match(runner, /eventWriter\.enqueue/);
  assert.match(runner, /options\.onEvent/);
  assert.match(runner, /await eventWriter\.drain\(\)/);
  assert.match(store, /CHAT_JOB_LEASE_MS/);
  assert.match(route, /streamChatJob/);
  assert.match(route, /text\/event-stream/);
  assert.doesNotMatch(route, /runChatJob|generateChatResponse/);
  assert.match(atomicSql, /lease_expires_at/);
  assert.match(atomicSql, /heartbeat_at/);
  assert.match(atomicSql, /attempt_count/);
  assert.match(atomicSql, /create or replace function public\.claim_chat_job/);
  assert.match(atomicSql, /for update/);
  assert.match(atomicSql, /p_max_attempts/);
  assert.match(atomicSql, /lease_token/);
  assert.match(atomicSql, /lease_expires_at > now_at/);
  assert.match(atomicSql, /create or replace function public\.heartbeat_chat_job/);
  assert.match(atomicSql, /create or replace function public\.append_chat_job_events/);
  assert.match(atomicSql, /on conflict \(owner_id, conversation_id, job_id, event_id\) do nothing/);
  assert.match(atomicSql, /create or replace function public\.complete_chat_job_and_finalize_message/);
  assert.match(atomicSql, /create or replace function public\.register_chat_document/);
  assert.match(store, /submit_and_claim_chat_job/);
  assert.match(store, /claim_chat_job/);
  assert.match(store, /heartbeat_chat_job/);
  assert.match(store, /append_chat_job_events/);
  assert.match(store, /complete_chat_job_and_finalize_message/);
});

test("attachment-free submission and claim use one atomic RPC", async () => {
  const [migration, store, runner, route] = await Promise.all([
    source("supabase/migrations/20260730190000_chat_leases_atomic_persistence.sql"),
    source("app/server/chat/chat-job-store.ts"),
    source("app/server/chat/chat-job-runner.ts"),
    source("app/api/chat/route.ts"),
  ]);
  assert.match(migration, /submit_and_claim_chat_job/);
  assert.match(migration, /'queued'/);
  assert.match(migration, /exception when unique_violation/);
  assert.match(store, /submit_and_claim_chat_job/);
  assert.match(runner, /claimChatJob/);
  assert.doesNotMatch(route, /claimedRequest/);
});

test("replay is ordered, exclusive, and owner isolated", async () => {
  const store = await source("app/server/chat/chat-job-store.ts");
  assert.match(store, /where owner_id=\$1/);
  assert.match(store, /event_index>\$4 order by event_index/);
  assert.match(store, /databaseOwnerId\(ownerId\)/);
  assert.match(store, /CHAT_EVENT_PAGE_SIZE \+ 1/);
  assert.match(store, /hasMore/);
  const endpoint = await source("app/api/chat/jobs/[conversationId]/[jobId]/route.ts");
  assert.match(endpoint, /authorizeOwnerSession/);
  assert.match(endpoint, /getChatJob\(user\.id/);
});

test("live delivery uses SSE while recovery uses bounded exponential backoff", async () => {
  const [service, recovery, hook, backoff] = await Promise.all([
    source("app/chat/chat-service.ts"),
    source("app/chat/chat-job-recovery.ts"),
    source("app/chat/use-persisted-job-recovery.ts"),
    source("app/chat/chat-retry-backoff.ts"),
  ]);
  assert.match(service, /readChatLiveStream/);
  assert.match(service, /snapshot\.hasMore/);
  assert.match(service, /waitForChatRetry/);
  assert.match(recovery, /resumeChatJob/);
  assert.match(recovery, /waitForChatRetry/);
  assert.match(hook, /visibilitychange/);
  assert.match(backoff, /Math\.min\(maxMs/);
  assert.match(backoff, /0\.8 \+ random\(\) \* 0\.4/);
});

test("disconnect is delivery-only while explicit stop calls durable cancellation", async () => {
  const [page, generation, runner] = await Promise.all([source("app/page.tsx"), source("app/chat/use-chat-generation.ts"), source("app/server/chat/chat-job-runner.ts")]);
  const client = `${page}\n${generation}`;
  assert.match(client, /controller\.abort\(\)/);
  assert.match(client, /await cancelChatJob/);
  assert.match(generation, /controller\.signal\.aborted[\s\S]*pendingEvents\.length = 0/);
  assert.match(runner, /renewChatJob/);
  assert.match(runner, /CHAT_JOB_HEARTBEAT_MS/);
});

test("page reload and visibility restoration retain sequence and final output", async () => {
  const [page, generation, recovery, hook, history] = await Promise.all([source("app/page.tsx"), source("app/chat/use-chat-generation.ts"), source("app/chat/chat-job-recovery.ts"), source("app/chat/use-persisted-job-recovery.ts"), source("lib/chat-history.ts")]);
  const client = `${page}\n${generation}\n${recovery}\n${hook}`;
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
