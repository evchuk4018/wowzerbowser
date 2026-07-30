import "server-only";

import type {
  DiscordAutomationDeliveryResult,
  DiscordAutomationNotification,
} from "../../../lib/discord-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";

type NotificationRow = {
  id: string;
  automation_run_id: string;
  conversation_id: string;
  title: string;
  message: string;
  status: "delivering";
  attempt_count: number;
};

function notification(row: NotificationRow): DiscordAutomationNotification {
  return {
    id: row.id,
    automationRunId: row.automation_run_id,
    conversationId: row.conversation_id,
    title: row.title,
    message: row.message,
    status: row.status,
    attemptCount: row.attempt_count,
  };
}

export async function enqueueDiscordAutomationNotification(input: {
  ownerId: string;
  automationRunId: string;
  conversationId: string;
  title: string;
  message: string;
}): Promise<void> {
  const { error } = await getServerClient().from("discord_automation_notifications").upsert({
    owner_id: input.ownerId,
    automation_run_id: input.automationRunId,
    conversation_id: input.conversationId,
    title: input.title,
    message: input.message,
  }, { onConflict: "owner_id,automation_run_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function claimDiscordAutomationNotifications(
  ownerId: string,
  limit = 10,
): Promise<DiscordAutomationNotification[]> {
  const { data, error } = await getServerClient().rpc("claim_discord_automation_notifications", {
    p_owner_id: ownerId,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: unknown) => notification(row as NotificationRow));
}

export async function finishDiscordAutomationNotification(
  ownerId: string,
  id: string,
  result: DiscordAutomationDeliveryResult,
): Promise<{ conversationId: string } | null> {
  const now = new Date();
  const values = result.status === "delivered"
    ? {
        status: "delivered",
        discord_channel_id: result.channelId,
        discord_message_id: result.messageId,
        delivered_at: now.toISOString(),
        lease_expires_at: null,
        last_error: null,
        updated_at: now.toISOString(),
      }
    : {
        status: "pending",
        lease_expires_at: null,
        next_attempt_at: new Date(now.getTime() + 30_000).toISOString(),
        last_error: result.error,
        updated_at: now.toISOString(),
      };
  const { data, error } = await getServerClient().from("discord_automation_notifications")
    .update(values)
    .eq("owner_id", ownerId)
    .eq("id", id)
    .eq("status", "delivering")
    .select("conversation_id")
    .maybeSingle();
  if (error) throw error;
  return data ? { conversationId: String(data.conversation_id) } : null;
}

export async function getDeliveringDiscordAutomationNotification(
  ownerId: string,
  id: string,
): Promise<{ conversationId: string } | null> {
  const { data, error } = await getServerClient().from("discord_automation_notifications")
    .select("conversation_id")
    .eq("owner_id", ownerId)
    .eq("id", id)
    .eq("status", "delivering")
    .maybeSingle();
  if (error) throw error;
  return data ? { conversationId: String(data.conversation_id) } : null;
}
