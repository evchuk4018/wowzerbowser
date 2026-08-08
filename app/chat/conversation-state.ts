import type { Conversation, ConversationTurn, Message, TurnVersion } from "./conversation-types";

export { getActiveConversationTurns } from "../../lib/chat-history";

/** The state owned by the conversation workspace. */
export type ConversationState = {
  conversations: Conversation[];
  /** The selected conversation id, or an empty string while none is selected. */
  activeId: string;
};

export type LoadConversationsAction = {
  type: "LOAD_CONVERSATIONS";
  conversations: Conversation[];
  activeId?: string | null;
};

export type HydrateConversationAction = {
  type: "HYDRATE_CONVERSATION";
  conversation: Conversation;
  select?: boolean;
};

export type CreateConversationAction = {
  type: "CREATE_CONVERSATION";
  conversation: Conversation;
};

export type SelectConversationAction = {
  type: "SELECT_CONVERSATION";
  conversationId: string;
};

export type RemoveConversationAction = {
  type: "REMOVE_CONVERSATION";
  conversationId: string;
  /** A replacement is used when the deleted conversation was active. */
  replacement?: Conversation;
};

export type UpdateTitleAction = {
  type: "UPDATE_TITLE";
  conversationId: string;
  title: string;
};

export type SetProjectAction = {
  type: "SET_PROJECT_ID";
  conversationId: string;
  projectId: string | null;
};

export type AppendTurnAction = {
  type: "APPEND_TURN";
  conversationId: string;
  turn: ConversationTurn;
};

export type AppendTurnVersionAction = {
  type: "APPEND_TURN_VERSION";
  conversationId: string;
  turnId: string;
  version: TurnVersion;
};

export type SelectTurnVersionAction = {
  type: "SELECT_TURN_VERSION";
  conversationId: string;
  turnId: string;
  /** The requested version index. The reducer clamps this to the valid range. */
  versionIndex: number;
  /** Prefer the stable id when the transcript is a branch projection. */
  versionId?: string;
  /** Keep the blind comparison metadata while the user is deciding. */
  preserveAbTestComparison?: boolean;
};

export type UpdateMessageAction = {
  type: "UPDATE_MESSAGE";
  conversationId: string;
  messageId: string;
  /** A serializable partial message update; callbacks are intentionally not supported. */
  patch: Partial<Message>;
};

export type MarkMessageCompleteAction = {
  type: "MARK_MESSAGE_COMPLETE";
  conversationId: string;
  messageId: string;
  finalOutput?: string | null;
  streamMetrics?: Message["streamMetrics"];
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
  | HydrateConversationAction
  | CreateConversationAction
  | SelectConversationAction
  | RemoveConversationAction
  | UpdateTitleAction
  | SetProjectAction
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
