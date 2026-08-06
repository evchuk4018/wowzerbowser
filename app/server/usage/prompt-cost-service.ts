import "server-only";

import type { ChatRunCost } from "../../../lib/chat-protocol";
import type { UsageRecordInput } from "../../../lib/usage-protocol";
import { flushUsageOutbox, recordUsage } from "./usage-store";
import { refreshChatJobCost } from "./prompt-cost-repository";

export async function recordPromptUsage(input: UsageRecordInput): Promise<ChatRunCost | null> {
  await recordUsage(input);
  if (!input.conversationId || !input.jobId || input.requestKind === "dreaming") return null;
  await flushUsageOutbox(input.ownerId).catch(() => undefined);
  return refreshChatJobCost(input.ownerId, input.conversationId, input.jobId).catch(() => null);
}

export async function refreshPromptCost(
  ownerId: string,
  conversationId: string,
  jobId: string,
): Promise<ChatRunCost | null> {
  await flushUsageOutbox(ownerId).catch(() => undefined);
  return refreshChatJobCost(ownerId, conversationId, jobId).catch(() => null);
}
