import "server-only";

import { randomUUID } from "node:crypto";
import { generateQwenTitle } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { updateChatConversationTitle } from "./chat-history-store";
import { recordUsage } from "../usage/usage-store";

export async function generateAndPersistChatTitle(
  ownerId: string,
  conversationId: string,
  firstTurn: string,
): Promise<string> {
  const requestId = randomUUID();
  const title = await generateQwenTitle(firstTurn, async ({ model, usage, estimatedUsage, exactCostUsd }) => {
    await recordUsage({
      ownerId,
      provider: "openrouter",
      model,
      requestKind: "title",
      requestId,
      round: 0,
      usage: usage ?? estimatedUsage,
      source: usage ? "exact" : "estimated",
      exactCostUsd,
      unpriced: exactCostUsd === undefined,
    });
  });
  await updateChatConversationTitle(ownerId, conversationId, title);
  return title;
}
