import { createConversation } from "./conversation-defaults";
import type { ConversationState } from "./conversation-state";
import type { Conversation } from "./conversation-types";
import type { LoadedConversations } from "./conversation-storage";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConversationRouteResolution =
  | { type: "none" }
  | { type: "select"; conversationId: string }
  | { type: "create"; conversation: Conversation }
  | { type: "redirect"; conversationId: string };

/** Keep a valid direct-link UUID local until its first message is submitted. */
export function mergeRequestedConversation(
  loaded: LoadedConversations,
  requestedId?: string,
): Conversation[] {
  const requestedMissing = Boolean(
    requestedId
      && UUID_PATTERN.test(requestedId)
      && !loaded.conversations.some(({ id }) => id === requestedId),
  );

  if (requestedMissing) {
    return [{ ...createConversation(), id: requestedId as string }, ...loaded.conversations];
  }

  return loaded.conversations.length
    ? loaded.conversations
    : [createConversation()];
}

/** Resolve one route value against the workspace state. */
export function resolveConversationRoute(
  state: ConversationState,
  requestedConversationId?: string,
): ConversationRouteResolution {
  if (!state.activeId) return { type: "none" };

  if (!requestedConversationId) {
    return { type: "redirect", conversationId: state.activeId };
  }

  if (state.conversations.some(({ id }) => id === requestedConversationId)) {
    return state.activeId === requestedConversationId
      ? { type: "none" }
      : { type: "select", conversationId: requestedConversationId };
  }

  if (UUID_PATTERN.test(requestedConversationId)) {
    return {
      type: "create",
      conversation: { ...createConversation(), id: requestedConversationId },
    };
  }

  return { type: "redirect", conversationId: state.activeId };
}
