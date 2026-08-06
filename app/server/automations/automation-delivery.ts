import "server-only";
import { createCompletedAutomationConversation } from "../chat/chat-history-store";

export type AutomationDelivery = {
  ownerId: string;
  runId: string;
  title: string;
  prompt: string;
  message: string;
};

export interface AutomationDeliveryAdapter {
  deliver(input: AutomationDelivery): Promise<{ conversationId?: string }>;
}

export const chatAutomationDelivery: AutomationDeliveryAdapter = {
  async deliver(input) {
    return {
      conversationId: await createCompletedAutomationConversation({
        ownerId: input.ownerId,
        runId: input.runId,
        title: input.title,
        prompt: input.prompt,
        output: input.message,
      }),
    };
  },
};
