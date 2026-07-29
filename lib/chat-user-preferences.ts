import { isChatModelRef, type ChatModelRef } from "./chat-protocol";

export type ChatUserPreferences = {
  userPresence: string;
  visionModel?: ChatModelRef | null;
};

export const DEFAULT_CHAT_USER_PREFERENCES: ChatUserPreferences = {
  userPresence: "",
  visionModel: null,
};

export function parseChatUserPreferences(value: unknown): ChatUserPreferences | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { userPresence?: unknown; visionModel?: unknown };
  if (typeof candidate.userPresence !== "string" || candidate.userPresence.length > 12_000) return null;
  const visionModel = candidate.visionModel === null || candidate.visionModel === undefined
    ? null
    : isChatModelRef(candidate.visionModel) && candidate.visionModel.provider === "openrouter"
      ? candidate.visionModel
      : null;
  return { userPresence: candidate.userPresence.trim(), ...(Object.prototype.hasOwnProperty.call(candidate, "visionModel") ? { visionModel } : {}) };
}
