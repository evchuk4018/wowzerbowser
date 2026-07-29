import "server-only";

import { deleteChatModelPreference } from "./chat-model-preference-store";
import {
  cancelChatJobsForConversation,
  deleteChatJobsForConversation,
} from "./chat-job-store";
import {
  chatConversationExists,
  deleteChatConversationRecord,
  listChatConversations,
} from "./chat-history-store";
import { deleteConversationWorkspace } from "../modal/modal-conversation-cleanup";
import { deleteChatImagesForConversation } from "./chat-image-store";

/**
 * Delete one owner's conversation and all app/provider-owned data attached to
 * it. A missing database conversation is intentionally idempotent so a blank
 * client-only conversation can use the same endpoint.
 */
export async function deleteChatConversation(ownerId: string, conversationId: string): Promise<void> {
  if (!(await chatConversationExists(ownerId, conversationId))) return;

  await cancelChatJobsForConversation(ownerId, conversationId);
  await deleteConversationWorkspace(ownerId, conversationId);
  await deleteChatImagesForConversation(ownerId, conversationId);
  await deleteChatConversationRecord(ownerId, conversationId);
  await deleteChatModelPreference(ownerId, conversationId);
  await deleteChatJobsForConversation(ownerId, conversationId);
}

/**
 * Remove persisted conversations that never received a message. These rows
 * can be left behind when preparing an upload fails before chat submission.
 * Use the coordinated deletion path so provider-owned resources are cleaned
 * up along with the database row.
 */
export async function cleanupEmptyChatConversations(ownerId: string): Promise<void> {
  const summaries = await listChatConversations(ownerId);
  await Promise.all(
    summaries
      .filter((conversation) => !conversation.hasMessages)
      .map((conversation) => deleteChatConversation(ownerId, conversation.id)),
  );
}
