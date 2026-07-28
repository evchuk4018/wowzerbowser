import type {
  ChatConversation,
  ChatConversationTurn,
  ChatHistoryMessage,
} from "../../lib/chat-history";
import { getActiveConversationTurns } from "../../lib/chat-history";
import {
  initialConversationState,
  type ConversationAction,
  type ConversationState,
} from "./conversation-state";

export type { ConversationAction, ConversationState } from "./conversation-state";
export { initialConversationState } from "./conversation-state";

const conversationAt = (
  conversations: ChatConversation[],
  conversationId: string,
): ChatConversation | undefined => conversations.find(({ id }) => id === conversationId);

const updateConversation = (
  state: ConversationState,
  conversationId: string,
  update: (conversation: ChatConversation) => ChatConversation,
): ConversationState => {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    const next = update(conversation);
    changed ||= next !== conversation;
    return next;
  });
  return changed ? { ...state, conversations } : state;
};

const updateMessage = (
  conversation: ChatConversation,
  messageId: string,
  update: (message: ChatHistoryMessage) => ChatHistoryMessage,
): ChatConversation => {
  let changed = false;
  const turns = conversation.turns.map((turn) => {
    let turnChanged = false;
    const versions = turn.versions.map((version) => {
      const user = version.user.id === messageId ? update(version.user) : version.user;
      const assistant = version.assistant.id === messageId
        ? update(version.assistant)
        : version.assistant;
      const versionChanged = user !== version.user || assistant !== version.assistant;
      if (versionChanged) turnChanged = true;
      return versionChanged
        ? { ...version, user, assistant }
        : version;
    });
    if (!turnChanged) return turn;
    changed = true;
    return { ...turn, versions };
  });
  return changed ? { ...conversation, turns } : conversation;
};

const withMessageUpdate = (
  state: ConversationState,
  conversationId: string,
  messageId: string,
  update: (message: ChatHistoryMessage) => ChatHistoryMessage,
): ConversationState => updateConversation(state, conversationId, (conversation) =>
  updateMessage(conversation, messageId, update));

/**
 * Fill lineage for legacy descendants before creating or selecting a branch.
 * Legacy rows had no way to identify which later version followed the active
 * version, but the active linear path at migration time is unambiguous.
 */
function materializeLegacyLineage(
  conversation: ChatConversation,
  startIndex: number,
): ChatConversation {
  const activeTurns = getActiveConversationTurns(conversation);
  let parentVersionId = startIndex > 0
    ? activeTurns[startIndex - 1]?.versions[activeTurns[startIndex - 1].activeVersion]?.id ?? null
    : null;
  let changed = false;
  const turns = conversation.turns.map((turn, index) => {
    if (index < startIndex) return turn;
    const activeTurn = activeTurns[index];
    const selected = activeTurn?.versions[activeTurn.activeVersion]
      ?? turn.versions[turn.activeVersion];
    const versions = turn.versions.map((version) => {
      if (version.parentVersionId !== undefined) return version;
      changed = true;
      return { ...version, parentVersionId };
    });
    parentVersionId = selected?.id ?? parentVersionId;
    return versions.every((version, versionIndex) => version === turn.versions[versionIndex])
      ? turn
      : { ...turn, versions };
  });
  return changed ? { ...conversation, turns } : conversation;
}

/**
 * Apply a conversation action without mutating the previous state.
 *
 * The reducer deliberately accepts data-only actions. Streaming controllers
 * can dispatch an `UPDATE_MESSAGE` patch, while lifecycle actions provide the
 * common terminal status transitions without embedding setter callbacks in
 * state or action objects.
 */
export function conversationReducer(
  state: ConversationState = initialConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "LOAD_CONVERSATIONS": {
      const conversations = action.conversations.slice();
      const requestedId = action.activeId ?? "";
      const activeId = requestedId && conversationAt(conversations, requestedId)
        ? requestedId
        : (conversations[0]?.id ?? "");
      return { conversations, activeId };
    }

    case "HYDRATE_CONVERSATION": {
      const exists = state.conversations.some(
        ({ id }) => id === action.conversation.id,
      );
      const conversations = exists
        ? state.conversations.map((conversation) =>
            conversation.id === action.conversation.id
              ? action.conversation
              : conversation,
          )
        : [action.conversation, ...state.conversations];
      return {
        conversations,
        activeId:
          action.select || !state.activeId
            ? action.conversation.id
            : state.activeId,
      };
    }

    case "CREATE_CONVERSATION": {
      // Creating an existing id is treated as a replacement at the front. It
      // keeps the state invariant (one entry per id) during retry races.
      const conversations = [
        action.conversation,
        ...state.conversations.filter(({ id }) => id !== action.conversation.id),
      ];
      return { ...state, conversations, activeId: action.conversation.id };
    }

    case "SELECT_CONVERSATION":
      return conversationAt(state.conversations, action.conversationId)
        ? (state.activeId === action.conversationId
          ? state
          : { ...state, activeId: action.conversationId })
        : state;

    case "REMOVE_CONVERSATION": {
      const remaining = state.conversations.filter(({ id }) => id !== action.conversationId);
      if (remaining.length === state.conversations.length) return state;
      if (state.activeId !== action.conversationId) {
        return { ...state, conversations: remaining };
      }
      if (action.replacement) {
        return {
          conversations: [
            action.replacement,
            ...remaining.filter(({ id }) => id !== action.replacement?.id),
          ],
          activeId: action.replacement.id,
        };
      }
      return {
        conversations: remaining,
        activeId: remaining[0]?.id ?? "",
      };
    }

    case "UPDATE_TITLE":
      return updateConversation(state, action.conversationId, (conversation) =>
        conversation.title === action.title
          ? conversation
          : { ...conversation, title: action.title });

    case "APPEND_TURN":
      return updateConversation(state, action.conversationId, (conversation) => {
        const activeTurns = getActiveConversationTurns(conversation);
        const parentVersionId = activeTurns.at(-1)?.versions[activeTurns.at(-1)?.activeVersion ?? 0]?.id ?? null;
        const turn = action.turn.versions.some((version) => version.parentVersionId !== undefined)
          ? action.turn
          : {
              ...action.turn,
              versions: action.turn.versions.map((version) => ({ ...version, parentVersionId })),
            };
        return { ...conversation, turns: [...conversation.turns, turn] };
      });

    case "APPEND_TURN_VERSION":
      return updateConversation(state, action.conversationId, (conversation) => {
        const turnIndex = conversation.turns.findIndex((turn) => turn.id === action.turnId);
        if (turnIndex < 0) return conversation;
        const materialized = materializeLegacyLineage(conversation, turnIndex);
        const activeTurns = getActiveConversationTurns(conversation);
        const parentVersionId = activeTurns[turnIndex - 1]
          ?.versions[activeTurns[turnIndex - 1].activeVersion]?.id ?? null;
        const turns = materialized.turns.map((turn, index) => {
          if (index !== turnIndex) return turn;
          const appendedVersion = action.version.parentVersionId === undefined
            ? { ...action.version, parentVersionId }
            : action.version;
          const versions = [...turn.versions, appendedVersion];
          return { ...turn, versions, activeVersion: versions.length - 1 };
        });
        return { ...materialized, turns };
      });

    case "SELECT_TURN_VERSION":
      return updateConversation(state, action.conversationId, (conversation) => {
        const turnIndex = conversation.turns.findIndex((turn) => turn.id === action.turnId);
        if (turnIndex < 0) return conversation;
        const materialized = materializeLegacyLineage(conversation, turnIndex);
        let changed = false;
        const turns = materialized.turns.map((turn) => {
          if (turn.id !== action.turnId || turn.versions.length === 0) return turn;
          const requestedIndex = action.versionId
            ? turn.versions.findIndex((version) => version.id === action.versionId)
            : Math.trunc(action.versionIndex);
          const activeVersion = Math.max(0, Math.min(
            turn.versions.length - 1,
            requestedIndex < 0 ? 0 : requestedIndex,
          ));
          if (activeVersion === turn.activeVersion) return turn;
          changed = true;
          return { ...turn, activeVersion };
        });
        return changed || materialized !== conversation
          ? { ...materialized, turns }
          : conversation;
      });

    case "UPDATE_MESSAGE":
      return withMessageUpdate(
        state,
        action.conversationId,
        action.messageId,
        (message) => ({ ...message, ...action.patch }),
      );

    case "MARK_MESSAGE_COMPLETE":
      return withMessageUpdate(
        state,
        action.conversationId,
        action.messageId,
        (message) => ({
          ...message,
          ...(typeof action.finalOutput === "string" ? { content: action.finalOutput } : {}),
          status: "complete",
          error: undefined,
        }),
      );

    case "MARK_MESSAGE_CANCELLED":
      return withMessageUpdate(state, action.conversationId, action.messageId, (message) => ({
        ...message,
        status: "cancelled",
      }));

    case "MARK_MESSAGE_ERROR":
      return withMessageUpdate(state, action.conversationId, action.messageId, (message) => ({
        ...message,
        status: "error",
        error: action.error,
      }));

    default: {
      const exhaustiveAction: never = action;
      return exhaustiveAction;
    }
  }
}

/** Create a state-independent empty state for useReducer initializers. */
export function createInitialConversationState(): ConversationState {
  return { conversations: [], activeId: "" };
}

/** A small helper used by callers that need to append a new turn. */
export function appendTurn(
  state: ConversationState,
  conversationId: string,
  turn: ChatConversationTurn,
): ConversationState {
  return conversationReducer(state, { type: "APPEND_TURN", conversationId, turn });
}
