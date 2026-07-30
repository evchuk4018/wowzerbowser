import "server-only";

import type { DiscordAutomationDeliveryResult } from "../../../lib/discord-protocol";
import { configuredOwner } from "../../auth/owner-auth-service";
import {
  claimDiscordAutomationNotifications,
  finishDiscordAutomationNotification,
  getDeliveringDiscordAutomationNotification,
} from "./discord-automation-repository";
import { setActiveDiscordConversation } from "./discord-repository";

function allowedDiscordUser(): string {
  const value = process.env.DISCORD_ALLOWED_USER_ID?.trim();
  if (!value || !/^\d{1,24}$/.test(value)) throw new Error("DISCORD_ALLOWED_USER_ID is not configured.");
  return value;
}

export async function pendingDiscordAutomationNotifications() {
  const owner = await configuredOwner();
  return claimDiscordAutomationNotifications(owner.id);
}

export async function completeDiscordAutomationNotification(
  id: string,
  result: DiscordAutomationDeliveryResult,
): Promise<void> {
  const owner = await configuredOwner();
  if (result.status === "delivered") {
    const notification = await getDeliveringDiscordAutomationNotification(owner.id, id);
    if (!notification) return;
    await setActiveDiscordConversation(owner.id, allowedDiscordUser(), result.channelId, notification.conversationId);
  }
  await finishDiscordAutomationNotification(owner.id, id, result);
}
