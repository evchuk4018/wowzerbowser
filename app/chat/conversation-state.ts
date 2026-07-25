import type {
  ChatConversation,
  ChatConversationTurn,
  ChatHistoryMessage,
  ChatTurnVersion,
} from "../../lib/chat-history";

/** The state owned by the conversation workspace. */
export type ConversationState = {
  conversations: ChatConversation[];
  /** The selected conversation id, or an empty string while none is selected. */
  activeId: string;
};

export type LoadConversationsAction = {
  type: "LOAD_CONVERSATIONS";
  conversations: ChatConversation[];
  activeId?: string | null;
};

export type CreateConversationAction = {
  type: "CREATE_CONVERSATION";
  conversation: ChatConversation;
};

export type SelectConversationAction = {
  type: "SELECT_CONVERSATION";
  conversationId: string;
};

export type UpdateTitleAction = {
  type: "UPDATE_TITLE";
  conversationId: string;
  title: string;
};

export type AppendTurnAction = {
  type: "APPEND_TURN";
  conversationId: string;
  turn: ChatConversationTurn;
};

export type AppendTurnVersionAction = {
  type: "APPEND_TURN_VERSION";
  conversationId: string;
  turnId: string;
  version: ChatTurnVersion;
};

export type SelectTurnVersionAction = {
  type: "SELECT_TURN_VERSION";
  conversationId: string;
  turnId: string;
  /** The requested version index. The reducer clamps this to the valid range. */
  versionIndex: number;
};

export type UpdateMessageAction = {
  type: "UPDATE_MESSAGE";
  conversationId: string;
  messageId: string;
  /** A serializable partial message update; callbacks are intentionally not supported. */
  patch: Partial<ChatHistoryMessage>;
};

export type MarkMessageCompleteAction = {
  type: "MARK_MESSAGE_COMPLETE";
  conversationId: string;
  messageId: string;
  finalOutput?: string | null;
};

export type MarkMessageCancelledAction = {
  type: "MARK_MESSAGE_CANCELLED";
  conversationId: string;
  messageId: string;
};

export type MarkMessageErrorAction = {
  type: "MARK_MESSAGE_ERROR";
  conversationId: string;
  messageId: string;
  error: string;
};

export type ConversationAction =
  | LoadConversationsAction
  | CreateConversationAction
  | SelectConversationAction
  | UpdateTitleAction
  | AppendTurnAction
  | AppendTurnVersionAction
  | SelectTurnVersionAction
  | UpdateMessageAction
  | MarkMessageCompleteAction
  | MarkMessageCancelledAction
  | MarkMessageErrorAction;

export const initialConversationState: ConversationState = {
  conversations: [],
  activeId: "",
};

