import type {
  ChatConversation,
  ChatConversationTurn,
  ChatHistoryMessage,
  ChatTurnVersion,
} from "../../lib/chat-history";
import type { ChatModelRef } from "../../lib/chat-protocol";

/** The persisted assistant/user message shape used by chat history. */
export type Message = ChatHistoryMessage;

/** One persisted prompt/response version within a conversation turn. */
export type TurnVersion = ChatTurnVersion;

/** A conversation turn containing one or more editable versions. */
export type ConversationTurn = ChatConversationTurn;

/** The persisted conversation shape. */
export type Conversation = ChatConversation;

/** User-editable chat settings. */
export type ChatSettings = {
  systemPrompt: string;
  userPresence: string;
  visionModel: ChatModelRef | null;
  automationModel: ChatModelRef;
  automationThinking: boolean;
  focusedContextEnabled: boolean;
};
