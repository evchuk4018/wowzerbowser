import {
  CHAT_REASONING_EFFORTS,
  DEFAULT_CHAT_MODELS,
  isChatModelRef,
  type ChatModelInfo,
  type ChatModelRef,
  type ChatReasoningEffort,
} from "./chat-protocol";

export type ChatModelPreference = {
  model: ChatModelRef;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
};

export const DEFAULT_CHAT_MODEL_PREFERENCE: ChatModelPreference = {
  model: DEFAULT_CHAT_MODELS[0].ref,
  thinking: false,
  reasoningEffort: "high",
};

export function parseChatModelPreference(value: unknown): ChatModelPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const legacyModel = typeof candidate.model === "string"
    ? { provider: typeof candidate.provider === "string" ? candidate.provider : "deepseek", model: candidate.model }
    : candidate.model;
  if (!isChatModelRef(legacyModel) || typeof candidate.thinking !== "boolean") return null;
  if (!CHAT_REASONING_EFFORTS.includes(candidate.reasoningEffort as ChatReasoningEffort)) return null;
  return {
    model: legacyModel,
    thinking: candidate.thinking,
    reasoningEffort: candidate.reasoningEffort as ChatReasoningEffort,
  };
}

export function normalizeModelPreference(
  preference: ChatModelPreference,
  metadata: ChatModelInfo,
): ChatModelPreference {
  const efforts = metadata.supportedEfforts;
  const effort = efforts.includes(preference.reasoningEffort)
    ? preference.reasoningEffort
    : metadata.defaultReasoningEffort && efforts.includes(metadata.defaultReasoningEffort)
      ? metadata.defaultReasoningEffort
      : efforts.includes("medium")
        ? "medium"
        : efforts[0] ?? "medium";
  const canReason = efforts.length > 0;
  return {
    model: metadata.ref,
    thinking: metadata.reasoningRequired || (canReason && preference.thinking),
    reasoningEffort: effort,
  };
}
