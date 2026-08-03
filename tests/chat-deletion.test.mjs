import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { conversationReducer, initialConversationState } from "../app/chat/conversation-reducer.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("deletion exposes an authenticated idempotent API and coordinated cleanup", async () => {
  const [route, service, history, jobs, preferences, modal] = await Promise.all([
    source("app/api/chat/conversations/[conversationId]/route.ts"),
    source("app/server/chat/chat-conversation-service.ts"),
    source("app/server/chat/chat-history-store.ts"),
    source("app/server/chat/chat-job-store.ts"),
    source("app/server/chat/chat-model-preference-store.ts"),
    source("app/server/modal/modal-conversation-cleanup.ts"),
  ]);

  assert.match(route, /export async function DELETE/);
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /idPattern\.test\(conversationId\)/);
  assert.match(route, /deleteChatConversation\(owner\.id, conversationId\)/);
  assert.match(service, /chatConversationExists/);
  assert.match(service, /export async function cleanupEmptyChatConversations/);
  assert.match(service, /listChatConversations\(ownerId\)/);
  assert.match(service, /filter\(\(conversation\) => !conversation\.hasMessages/);
  assert.match(service, /cleanupEmptyChatConversation\(ownerId, conversation\.id\)/);
  assert.match(service, /cancelChatJobsForConversation/);
  assert.match(service, /deleteConversationWorkspace/);
  assert.match(service, /deleteChatConversationRecord/);
  assert.match(service, /deleteChatModelPreference/);
  assert.match(service, /deleteChatJobsForConversation/);
  assert.match(history, /delete from chat_conversations where owner_id=\$1/);
  assert.match(preferences, /delete from chat_model_preferences where owner_id/);
  assert.match(jobs, /delete from chat_jobs where owner_id=\$1/);
  assert.match(jobs, /cancel_chat_job_and_finalize_message/);
  assert.match(modal, /sandbox\.terminate\(\)/);
  assert.match(modal, /client\.volumes\.delete/);
  assert.match(modal, /allowMissing: true/);
});

test("chat bootstrap loads the index without cleanup writes", async () => {
  const [bootstrap, service, maintenance] = await Promise.all([
    source("app/server/chat/chat-bootstrap-service.ts"),
    source("app/server/chat/chat-conversation-service.ts"),
    source("app/api/internal/chat/maintenance/route.ts"),
  ]);

  assert.doesNotMatch(bootstrap, /cleanup(?:Empty|Stale)ChatConversations/);
  assert.match(bootstrap, /const \[summaries/);
  assert.equal((bootstrap.match(/listChatConversations\(owner\.id\)/g) ?? []).length, 1);
  assert.match(service, /export async function cleanupEmptyChatConversation/);
  assert.match(service, /export async function cleanupStaleEmptyChatConversations/);
  assert.match(service, /CHAT_EMPTY_CONVERSATION_CLEANUP_LIMIT/);
  assert.match(service, /chatConversationHasMessages/);
  assert.match(maintenance, /cleanupStaleEmptyChatConversations/);
  assert.match(maintenance, /CHAT_MAINTENANCE_SECRET/);
});

test("attachment preparation failures clean up only message-free conversations at the source", async () => {
  const [images, finalize, documents] = await Promise.all([
    source("app/api/chat/images/route.ts"),
    source("app/api/chat/documents/finalize/route.ts"),
    source("app/api/chat/documents/delete/route.ts"),
  ]);

  assert.match(images, /cleanupEmptyChatConversation/);
  assert.match(images, /scheduleCleanup\(\(\) => dependencies\.cleanupEmptyChatConversation/);
  assert.match(finalize, /cleanupEmptyChatConversation/);
  assert.match(finalize, /scheduleCleanup\(\(\) => deps\.cleanupEmptyChatConversation/);
  assert.match(documents, /cleanupEmptyChatConversation/);
  assert.match(documents, /scheduleCleanup\(\(\) => deps\.cleanupEmptyChatConversation/);
});

test("desktop and mobile history controls share the confirmation flow", async () => {
  const [workspace, sidebar, actions, dialog, sidebarStyles, responsiveStyles] = await Promise.all([
    source("app/chat/chat-workspace.tsx"),
    source("app/chat/chat-sidebar.tsx"),
    source("app/chat/conversation-actions.tsx"),
    source("app/chat/delete-confirmation-dialog.tsx"),
    source("app/styles/sidebar.css"),
    source("app/styles/responsive.css"),
  ]);

  assert.match(sidebar, /conversation-delete-button/);
  assert.match(sidebar, /aria-label=\{`Delete conversation:/);
  assert.match(sidebar, /onPointerDown/);
  assert.match(sidebar, /onContextMenu/);
  assert.match(actions, />Delete<\/span>/);
  assert.match(actions, />Rename<\/span>/);
  assert.match(actions, /disabled/);
  assert.match(dialog, />Are you sure\?<\/h2>/);
  assert.match(workspace, /await generation\.stopStreaming\(conversationId\)/);
  assert.match(workspace, /type: "REMOVE_CONVERSATION"/);
  assert.match(workspace, /setTimeout\(\(\) => \{/);
  assert.match(sidebarStyles, /\.conversation-row:hover \.conversation-delete-button/);
  assert.match(responsiveStyles, /\.conversation-actions-open \.conversation-item/);
  assert.match(responsiveStyles, /\.conversation-action-popover/);
});

test("reducer deletion replacement keeps a new chat active", () => {
  const first = { id: "one", title: "One", turns: [] };
  const second = { id: "two", title: "Two", turns: [] };
  const blank = { id: "blank", title: "New conversation", turns: [] };
  const state = conversationReducer(initialConversationState, {
    type: "LOAD_CONVERSATIONS",
    conversations: [first, second],
  });
  const next = conversationReducer(state, {
    type: "REMOVE_CONVERSATION",
    conversationId: "one",
    replacement: blank,
  });

  assert.equal(next.activeId, "blank");
  assert.deepEqual(next.conversations.map(({ id }) => id), ["blank", "two"]);
});
