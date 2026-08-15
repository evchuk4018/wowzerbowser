/** Provider and model metadata shared by chat execution and settings. */
export const CHAT_PROVIDERS = ["deepseek", "openrouter", "opencode"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export type ChatModelRef = { provider: ChatProvider; model: string };

export const CHAT_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatReasoningEffort = (typeof CHAT_REASONING_EFFORTS)[number];

export type ChatModelPricing = {
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  requestUsd: number | null;
  reasoningUsdPerMillion: number | null;
};

export type ChatModelInfo = {
  ref: ChatModelRef;
  displayName: string;
  description: string | null;
  author: string | null;
  architecture: string | null;
  inputModalities: string[];
  outputModalities: string[];
  toolSupport: boolean;
  supportedParameters: string[];
  reasoningRequired: boolean;
  supportedEfforts: ChatReasoningEffort[];
  defaultReasoningEffort: ChatReasoningEffort | null;
  contextLength: number;
  createdAt: string | null;
  pricing: ChatModelPricing | null;
};

export const DEFAULT_CHAT_MODELS: ChatModelInfo[] = [
  {
    ref: { provider: "deepseek", model: "deepseek-v4-flash" },
    displayName: "DeepSeek V4 Flash",
    description: "Fast built-in general-purpose chat model.",
    author: "DeepSeek",
    architecture: "DeepSeek V4",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools", "reasoning"],
    reasoningRequired: false,
    supportedEfforts: ["high", "max"],
    defaultReasoningEffort: "high",
    contextLength: 1_000_000,
    createdAt: null,
    pricing: { inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28, requestUsd: null, reasoningUsdPerMillion: 0.28 },
  },
  {
    ref: { provider: "deepseek", model: "deepseek-v4-pro" },
    displayName: "DeepSeek V4 Pro",
    description: "Built-in high-capability general-purpose chat model.",
    author: "DeepSeek",
    architecture: "DeepSeek V4",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools", "reasoning"],
    reasoningRequired: false,
    supportedEfforts: ["high", "max"],
    defaultReasoningEffort: "high",
    contextLength: 1_000_000,
    createdAt: null,
    pricing: { inputUsdPerMillion: 0.435, cachedInputUsdPerMillion: 0.003625, outputUsdPerMillion: 0.87, requestUsd: null, reasoningUsdPerMillion: 0.87 },
  },
];

export function chatModelIdentity(ref: ChatModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isChatModelRef(value: unknown): value is ChatModelRef {
  if (!isRecord(value)) return false;
  return CHAT_PROVIDERS.includes(value.provider as ChatProvider)
    && typeof value.model === "string"
    && /^[a-zA-Z0-9._:/-]{1,256}$/.test(value.model);
}
