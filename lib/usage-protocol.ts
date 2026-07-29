import type { ChatUsage } from "./chat-protocol";

export const USAGE_RANGES = ["day", "week", "month", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_SOURCES = ["exact", "estimated"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_REQUEST_KINDS = [
  "chat",
  "title",
  "reasoning_summary",
  "image_text_analysis",
  "image_visual_analysis",
  "image_followup",
  "chat_summary",
  "chat_recall",
  "dreaming",
  "todo_planner",
] as const;
export type UsageRequestKind = (typeof USAGE_REQUEST_KINDS)[number];

export type UsagePricing = {
  provider: string;
  model: string;
  label: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
};
export type UsageRecord = {
  provider: string;
  model: string;
  requestKind: UsageRequestKind;
  requestId: string;
  round: number;
  recordedAt: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  source: UsageSource;
  pricing: UsagePricing | null;
};

export type UsageModelSummary = {
  provider: string;
  model: string;
  label: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedRequestCount: number;
  unpricedRequestCount: number;
};

export type UsageBucket = {
  key: string;
  label: string;
  start: string;
  end: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedRequestCount: number;
  unpricedRequestCount: number;
  models: UsageModelSummary[];
};

export type UsageTotals = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedRequestCount: number;
  unpricedRequestCount: number;
};

export type UsageReport = {
  range: UsageRange;
  timeZone: string;
  generatedAt: string;
  buckets: UsageBucket[];
  totals: UsageTotals;
  models: UsageModelSummary[];
  pricing: UsagePricing[];
};

export type UsageRecordInput = {
  ownerId: string;
  provider: string;
  model: string;
  requestKind: UsageRequestKind;
  requestId: string;
  round: number;
  usage: ChatUsage;
  source: UsageSource;
  recordedAt?: string;
  conversationId?: string;
  jobId?: string;
  exactCostUsd?: number | null;
  pricingSnapshot?: UsagePricing | null;
  unpriced?: boolean;
};
