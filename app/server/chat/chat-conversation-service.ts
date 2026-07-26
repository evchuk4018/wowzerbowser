import "server-only";

import { deleteChatModelPreference } from "./chat-model-preference-store";
import {
  cancelChatJobsForConversation,
  deleteChatJobsForConversation,
} from "./chat-job-store";
import {
  chatConversationExists,
  deleteChatConversationRecord,
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
