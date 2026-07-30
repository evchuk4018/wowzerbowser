import "server-only";

import type { AutomationDelivery } from "../automations/automation-delivery";
import { enqueueDiscordAutomationNotification } from "./discord-automation-repository";

export async function queueDiscordAutomationDelivery(
  input: AutomationDelivery & { conversationId: string },
): Promise<void> {
  await enqueueDiscordAutomationNotification({
    ownerId: input.ownerId,
    automationRunId: input.runId,
    conversationId: input.conversationId,
    title: input.title,
    message: input.message,
  });
}
