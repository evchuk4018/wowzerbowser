import type { ChatUsage } from "./chat-protocol";

export const CHAT_SUMMARY_MAX_LENGTH = 12_000;
export const CHAT_SUMMARY_MAX_PROMPT_LENGTH = 100_000;
export const CHAT_SUMMARY_MAX_OUTPUT_TOKENS = 512;
export const CHAT_SUMMARY_TIMEOUT_MS = 15_000;
export const CHAT_SUMMARY_MAX_ATTEMPTS = 3;
export const CHAT_SUMMARY_RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const CHAT_SUMMARY_LEASE_MS = 120_000;
export const CHAT_SUMMARY_PROCESSING_BUDGET_MS = 50_000;

export const CHAT_SUMMARY_MODES = ["incremental", "rebuild"] as const;
export type ChatSummaryMode = (typeof CHAT_SUMMARY_MODES)[number];

export const CHAT_SUMMARY_TASK_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "superseded",
] as const;
export type ChatSummaryTaskStatus = (typeof CHAT_SUMMARY_TASK_STATUSES)[number];

export type ChatSummaryAnswer = {
  summary: string;
  provider: "deepseek";
  model: string;
  usage: ChatUsage | null;
};

export type ChatSummaryTask = {
  ownerId: string;
  conversationId: string;
  sourceJobId: string;
  sourceTurnId: string;
  sourceVersionId: string;
  sourcePosition: number;
  mode: ChatSummaryMode;
  status: ChatSummaryTaskStatus;
  attemptCount: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastError: string | null;
};

export type ChatSummaryInteraction = {
  userContent: string;
  assistantContent: string;
};
