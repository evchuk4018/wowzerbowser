import { createConversation } from "./conversation-defaults";
import type { ConversationState } from "./conversation-state";
import type { Conversation } from "./conversation-types";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConversationRouteResolution =
  | { type: "none" }
  | { type: "select"; conversationId: string }
  | { type: "load"; conversationId: string }
  | { type: "create"; conversation: Conversation }
  | { type: "redirect"; conversationId: string };

export function resolveConversationRoute(
  state: ConversationState,
  requestedConversationId?: string,
  knownConversationIds: ReadonlySet<string> = new Set(),
): ConversationRouteResolution {
  if (!requestedConversationId) {
    return state.activeId
      ? { type: "redirect", conversationId: state.activeId }
      : { type: "none" };
  }
  if (
    state.conversations.some(
      ({ id }) => id === requestedConversationId,
    )
  ) {
    return state.activeId === requestedConversationId
      ? { type: "none" }
      : {
          type: "select",
          conversationId: requestedConversationId,
        };
  }
  if (knownConversationIds.has(requestedConversationId)) {
    return {
      type: "load",
      conversationId: requestedConversationId,
    };
  }
  if (UUID_PATTERN.test(requestedConversationId)) {
    return {
      type: "create",
      conversation: {
        ...createConversation(),
        id: requestedConversationId,
      },
    };
  }
  return state.activeId
    ? { type: "redirect", conversationId: state.activeId }
    : { type: "none" };
}
