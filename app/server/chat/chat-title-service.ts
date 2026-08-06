import "server-only";

import { randomUUID } from "node:crypto";
import { generateQwenTitle } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { updateChatConversationTitle } from "./chat-history-store";
import { recordPromptUsage } from "../usage/prompt-cost-service";

export async function generateAndPersistChatTitle(
  ownerId: string,
  conversationId: string,
  firstTurn: string,
  jobId?: string,
): Promise<string> {
  const requestId = randomUUID();
  const title = await generateQwenTitle(firstTurn, async ({ model, usage, estimatedUsage, exactCostUsd }) => {
    await recordPromptUsage({
      ownerId,
      provider: "openrouter",
      model,
      requestKind: "title",
      requestId,
      round: 0,
      usage: usage ?? estimatedUsage,
      source: usage || exactCostUsd !== undefined ? "exact" : "estimated",
      exactCostUsd,
      unpriced: exactCostUsd === undefined,
      conversationId,
      jobId,
    });
  });
  await updateChatConversationTitle(ownerId, conversationId, title);
  return title;
}
