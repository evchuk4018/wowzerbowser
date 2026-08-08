import type {
  ChatConversation,
  ChatConversationTurn,
  ChatHistoryMessage,
  ChatTurnVersion,
} from "../../lib/chat-history";
import type { AbTestDisplayLabel, AbTestVariantKey } from "../../lib/ab-test-protocol";
import type { ChatModelRef } from "../../lib/chat-protocol";

export type ConversationAbTestComparison = {
  id: string;
  trialId: string;
  turnId: string;
  displayAVariant: AbTestVariantKey;
  options: {
    a: { responseId: string };
    b: { responseId: string };
  };
  status: "pending" | "voted";
  selected: AbTestDisplayLabel | null;
  variantKey: AbTestVariantKey;
};

/** The persisted assistant/user message shape used by chat history. */
export type Message = ChatHistoryMessage & {
  /** Client-only metadata for a blind paired response. */
  abTestComparison?: ConversationAbTestComparison;
};

/** One persisted prompt/response version within a conversation turn. */
export type TurnVersion = Omit<ChatTurnVersion, "user" | "assistant"> & {
  user: Message;
  assistant: Message;
};

/** A conversation turn containing one or more editable versions. */
export type ConversationTurn = Omit<ChatConversationTurn, "versions"> & {
  versions: TurnVersion[];
};

/** The persisted conversation shape. */
export type Conversation = Omit<ChatConversation, "turns"> & {
  turns: ConversationTurn[];
};

/** User-editable chat settings. */
export type ChatSettings = {
  systemPrompt: string;
  userPresence: string;
  visionModel: ChatModelRef | null;
  automationModel: ChatModelRef;
  focusedContextEnabled: boolean;
};
