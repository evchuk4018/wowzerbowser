export const CHAT_MODEL_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];

export type ChatReasoningEffort = "high" | "max";

export type ChatMessageInput = {
  role: "user" | "assistant";
  content: string;
};

export type ChatRequest = {
  messages: ChatMessageInput[];
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
};

export type ChatModelInfo = {
  id: ChatModelId;
  label: string;
  thinkingSupported: boolean;
  supportedEfforts: ChatReasoningEffort[];
};

export type ChatStreamEvent =
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "meta"; model: ChatModelId; thinking: boolean; reasoningEffort: ChatReasoningEffort }
  | { type: "done"; usage: ChatUsage | null }
  | { type: "error"; message: string };

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export class ChatRequestValidationError extends Error {}

export const DEFAULT_CHAT_MODELS: ChatModelInfo[] = [
  {
    id: "deepseek-v4-flash",
    label: "V4 Flash",
    thinkingSupported: true,
    supportedEfforts: ["high", "max"],
  },
  {
    id: "deepseek-v4-pro",
    label: "V4 Pro",
    thinkingSupported: true,
    supportedEfforts: ["high", "max"],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChatRequestValidationError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function parseChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new ChatRequestValidationError("messages must be an array.");
  }

  const messages = value.messages.map((message, index) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      throw new ChatRequestValidationError(`messages[${index}].role is invalid.`);
    }
    return {
      role: message.role,
      content: readNonEmptyString(message.content, `messages[${index}].content`),
    } as ChatMessageInput;
  });

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatRequestValidationError("messages must end with a user message.");
  }

  if (!CHAT_MODEL_IDS.includes(value.model as ChatModelId)) {
    throw new ChatRequestValidationError("model is not supported.");
  }

  if (typeof value.thinking !== "boolean") {
    throw new ChatRequestValidationError("thinking must be a boolean.");
  }

  if (value.reasoningEffort !== "high" && value.reasoningEffort !== "max") {
    throw new ChatRequestValidationError("reasoningEffort must be high or max.");
  }

  return {
    messages,
    model: value.model as ChatModelId,
    thinking: value.thinking,
    reasoningEffort: value.reasoningEffort,
  };
}
