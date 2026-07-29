import type { AuthUser } from "../../auth/types";
import {
  resolveChatBootstrapSelection,
  streamingMapFor,
  type ChatBootstrapPayload,
  type StoredChatModelPreference,
} from "../../../lib/chat-bootstrap";
import {
  DEFAULT_CHAT_USER_PREFERENCES,
  parseChatUserPreferences,
} from "../../../lib/chat-user-preferences";
import { parseChatModelPreference } from "../../../lib/chat-model-preference";
import {
  getChatConversation,
  listChatConversations,
} from "./chat-history-store";
import { listChatModelPreferences } from "./chat-model-preference-store";
import { getChatUserPreferences } from "./chat-user-preferences-store";
import { cleanupEmptyChatConversations } from "./chat-conversation-service";

async function readUserPreferences(ownerId: string) {
  try {
    return parseChatUserPreferences(await getChatUserPreferences(ownerId)) ?? DEFAULT_CHAT_USER_PREFERENCES;
  } catch {
    return DEFAULT_CHAT_USER_PREFERENCES;
  }
}

async function readModelPreferences(ownerId: string): Promise<StoredChatModelPreference[]> {
  try {
    return (await listChatModelPreferences(ownerId)).flatMap((row) => {
      const preference = parseChatModelPreference(row);
      return preference && typeof row.conversationId === "string" && row.conversationId
        ? [{ conversationId: row.conversationId, ...preference }]
        : [];
    });
  } catch {
    return [];
  }
}

export async function buildChatBootstrap(
  owner: AuthUser,
  requestedConversationId?: string,
): Promise<ChatBootstrapPayload> {
  await cleanupEmptyChatConversations(owner.id);
  const requestedSelection = resolveChatBootstrapSelection([], requestedConversationId);
  const [summaries, userPreferences, modelPreferences, requestedConversation] = await Promise.all([
    listChatConversations(owner.id),
    readUserPreferences(owner.id),
    readModelPreferences(owner.id),
    requestedSelection.requestedConversationId
      ? getChatConversation(owner.id, requestedSelection.requestedConversationId)
      : Promise.resolve(null),
  ]);

  const selection = resolveChatBootstrapSelection(summaries, requestedConversationId);
  const activeConversation = selection.requestedConversationId
    ? requestedConversation
    : selection.loadConversationId
      ? await getChatConversation(owner.id, selection.loadConversationId)
      : null;

  return {
    user: owner,
    summaries,
    streamingByConversation: streamingMapFor(summaries),
    activeConversation,
    activeConversationId: activeConversation?.id ?? null,
    requestedConversationId: selection.requestedConversationId,
    userPreferences,
    modelPreferences,
  };
}
