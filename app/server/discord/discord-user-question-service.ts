import "server-only";

import { configuredOwner } from "../../auth/owner-auth-service";
import {
  claimDiscordUserQuestionNotifications,
  finishDiscordUserQuestionNotification,
} from "./discord-user-question-delivery-adapter";
import { setActiveDiscordConversation } from "./discord-repository";

export async function pendingDiscordUserQuestionNotifications() {
  const owner = await configuredOwner();
  return claimDiscordUserQuestionNotifications(owner.id);
}

export async function completeDiscordUserQuestionNotification(
  id: string,
  result: { status: "delivered"; channelId: string; messageId: string } | { status: "failed"; error: string },
): Promise<void> {
  const owner = await configuredOwner();
  if (result.status === "delivered") {
    const notification = result as { status: "delivered"; channelId: string; messageId: string };
    try {
      const rows = await claimDiscordUserQuestionNotifications(owner.id, 1);
      void rows;
    } catch {}
  }
  await finishDiscordUserQuestionNotification(owner.id, id, result);
}
