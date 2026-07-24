import {
  CHAT_MODEL_IDS,
  type ChatModelId,
  type ChatReasoningEffort,
} from "./chat-protocol";

export type ChatModelPreference = {
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
};

export const DEFAULT_CHAT_MODEL_PREFERENCE: ChatModelPreference = {
  model: "deepseek-v4-flash",
  thinking: true,
  reasoningEffort: "high",
};

export function parseChatModelPreference(value: unknown): ChatModelPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!CHAT_MODEL_IDS.includes(candidate.model as ChatModelId)) return null;
  if (typeof candidate.thinking !== "boolean") return null;
  if (candidate.reasoningEffort !== "high" && candidate.reasoningEffort !== "max") return null;
  return {
    model: candidate.model as ChatModelId,
    thinking: candidate.thinking,
    reasoningEffort: candidate.reasoningEffort,
  };
}
