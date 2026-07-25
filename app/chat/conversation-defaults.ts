import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../lib/chat-protocol";
import type { ChatSettings, Conversation } from "./conversation-types";

export { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../lib/chat-protocol";

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
  userPresence: "",
};

export function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

export function createConversation(): Conversation {
  return {
    id: makeId(),
    title: "New conversation",
    turns: [],
  };
}
