import { createConversation } from "./conversation-defaults";
import type { ConversationState } from "./conversation-state";
import type { Conversation } from "./conversation-types";
export { UUID_PATTERN, isValidConversationId } from "../../lib/chat-conversation-id";
import { isValidConversationId } from "../../lib/chat-conversation-id";

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
    return { type: "create", conversation: createConversation() };
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
  if (isValidConversationId(requestedConversationId)) {
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
