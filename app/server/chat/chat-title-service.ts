import "server-only";

import { randomUUID } from "node:crypto";
import { generateDeepSeekTitle } from "../../providers/deepseek/deepseek-title";
import { updateChatConversationTitle } from "./chat-history-store";
import { recordUsage } from "../usage/usage-store";

export async function generateAndPersistChatTitle(
  ownerId: string,
  conversationId: string,
  firstTurn: string,
): Promise<string> {
  const requestId = randomUUID();
  const title = await generateDeepSeekTitle(firstTurn, async ({ usage, estimatedUsage }) => {
    await recordUsage({
      ownerId,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      requestKind: "title",
      requestId,
      round: 0,
      usage: usage ?? estimatedUsage,
      source: usage ? "exact" : "estimated",
    });
  });
  await updateChatConversationTitle(ownerId, conversationId, title);
  return title;
}
