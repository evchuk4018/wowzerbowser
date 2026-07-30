import { isChatModelRef, type ChatModelRef } from "./chat-protocol";
import { DEFAULT_AUTOMATION_MODEL } from "./automation-protocol";

export type ChatUserPreferences = {
  userPresence: string;
  visionModel?: ChatModelRef | null;
  automationModel?: ChatModelRef;
  focusedContextEnabled?: boolean;
};

export const DEFAULT_CHAT_USER_PREFERENCES: ChatUserPreferences = {
  userPresence: "",
  visionModel: null,
  automationModel: DEFAULT_AUTOMATION_MODEL,
  focusedContextEnabled: false,
};

export function parseChatUserPreferences(value: unknown): ChatUserPreferences | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { userPresence?: unknown; visionModel?: unknown; automationModel?: unknown; focusedContextEnabled?: unknown };
  if (typeof candidate.userPresence !== "string" || candidate.userPresence.length > 12_000) return null;
  if (candidate.focusedContextEnabled !== undefined && typeof candidate.focusedContextEnabled !== "boolean") return null;
  const visionModel = candidate.visionModel === null || candidate.visionModel === undefined
    ? null
    : isChatModelRef(candidate.visionModel) && candidate.visionModel.provider === "openrouter"
      ? candidate.visionModel
      : null;
  const automationModel = isChatModelRef(candidate.automationModel) ? candidate.automationModel : DEFAULT_AUTOMATION_MODEL;
  return {
    userPresence: candidate.userPresence.trim(),
    ...(Object.prototype.hasOwnProperty.call(candidate, "visionModel") ? { visionModel } : {}),
    automationModel,
    focusedContextEnabled: candidate.focusedContextEnabled ?? false,
  };
}
