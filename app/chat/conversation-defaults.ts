import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../lib/chat-protocol";
import type { ChatSettings, Conversation } from "./conversation-types";
import { DEFAULT_AUTOMATION_MODEL } from "../../lib/automation-protocol";

export { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../lib/chat-protocol";

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
  userPresence: "",
  visionModel: null,
  automationModel: DEFAULT_AUTOMATION_MODEL,
  focusedContextEnabled: false,
};

export function makeId(): string {
  return crypto.randomUUID();
}

export function createConversation(projectId?: string | null): Conversation {
  return {
    id: makeId(),
    title: "New conversation",
    ...(projectId ? { projectId } : {}),
    turns: [],
  };
}
