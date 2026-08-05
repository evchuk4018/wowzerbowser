import "server-only";

import { deleteChatModelPreference } from "./chat-model-preference-store";
import {
  cancelChatJobsForConversation,
  deleteChatJobsForConversation,
} from "./chat-job-store";
import {
  chatConversationExists,
  chatConversationHasMessages,
  deleteChatConversationRecord,
  listChatConversations,
} from "./chat-history-store";
import { deleteConversationWorkspace } from "../python/local-python-conversation-cleanup";
import { deleteChatImagesForConversation } from "./chat-image-store";
import { deleteChatDocumentsForConversation } from "./chat-document-store";
import { deleteStorageObjectsForConversation } from "../storage/storage-service";

export const CHAT_EMPTY_CONVERSATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const CHAT_EMPTY_CONVERSATION_CLEANUP_LIMIT = 50;

/**
 * Delete one owner's conversation and all app/provider-owned data attached to
 * it. A missing database conversation is intentionally idempotent so a blank
 * client-only conversation can use the same endpoint.
 */
export async function deleteChatConversation(ownerId: string, conversationId: string): Promise<void> {
  if (!(await chatConversationExists(ownerId, conversationId))) return;

  await cancelChatJobsForConversation(ownerId, conversationId);
  await deleteConversationWorkspace(ownerId, conversationId);
  await deleteStorageObjectsForConversation(ownerId, conversationId);
  await deleteChatImagesForConversation(ownerId, conversationId);
  await deleteChatDocumentsForConversation(ownerId, conversationId);
  await deleteChatConversationRecord(ownerId, conversationId);
  await deleteChatModelPreference(ownerId, conversationId);
  await deleteChatJobsForConversation(ownerId, conversationId);
}

/**
 * Delete a client-created conversation only when it is still message-free.
 * Attachment routes use this after a failed preparation so an existing chat
 * can never be removed just because one of its attachments failed.
 */
export async function cleanupEmptyChatConversation(ownerId: string, conversationId: string): Promise<boolean> {
  if (!(await chatConversationExists(ownerId, conversationId))) return false;
  if (await chatConversationHasMessages(ownerId, conversationId)) return false;
  await deleteChatConversation(ownerId, conversationId);
  return true;
}

/**
 * Remove a bounded batch of old, message-free conversations. This is for a
 * scheduled maintenance request, never for the latency-sensitive bootstrap
 * request. The message check is repeated before each delete to avoid racing a
 * new chat submission.
 */
export async function cleanupStaleEmptyChatConversations(
  ownerId: string,
  options: {
    now?: Date;
    maxAgeMs?: number;
    limit?: number;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? CHAT_EMPTY_CONVERSATION_RETENTION_MS;
  const limit = Math.max(1, Math.min(options.limit ?? CHAT_EMPTY_CONVERSATION_CLEANUP_LIMIT, CHAT_EMPTY_CONVERSATION_CLEANUP_LIMIT));
  const cutoff = now.getTime() - maxAgeMs;
  const summaries = await listChatConversations(ownerId);
  const candidates = summaries
    .filter((conversation) => !conversation.hasMessages && !conversation.isStreaming && Number.isFinite(Date.parse(conversation.updatedAt)) && Date.parse(conversation.updatedAt) <= cutoff)
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .slice(0, limit);
  let deleted = 0;
  for (const conversation of candidates) {
    if (await cleanupEmptyChatConversation(ownerId, conversation.id)) deleted += 1;
  }
  return deleted;
}

/** Backward-compatible maintenance entry point for callers outside bootstrap. */
export async function cleanupEmptyChatConversations(ownerId: string): Promise<number> {
  return cleanupStaleEmptyChatConversations(ownerId);
}
