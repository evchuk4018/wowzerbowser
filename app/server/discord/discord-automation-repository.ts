import "server-only";

import type {
  DiscordAutomationDeliveryResult,
  DiscordAutomationNotification,
} from "../../../lib/discord-protocol";
import { databaseOwnerId, query } from "../database/database";

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
  await query(`insert into discord_automation_notifications(owner_id,automation_run_id,conversation_id,title,message)
    values($1,$2,$3,$4,$5) on conflict(owner_id,automation_run_id) do nothing`, [databaseOwnerId(input.ownerId), input.automationRunId, input.conversationId, input.title, input.message]);
}

export async function claimDiscordAutomationNotifications(
  ownerId: string,
  limit = 10,
): Promise<DiscordAutomationNotification[]> {
  const rows = await query<NotificationRow>("select id,automation_run_id,conversation_id,title,message,status,attempt_count from claim_discord_automation_notifications($1,$2)", [databaseOwnerId(ownerId), limit]);
  return rows.map(notification);
}

export async function finishDiscordAutomationNotification(
  ownerId: string,
  id: string,
  result: DiscordAutomationDeliveryResult,
): Promise<{ conversationId: string } | null> {
  const now = new Date();
  const params = result.status === "delivered"
    ? ["delivered", result.channelId, result.messageId, now.toISOString(), null, null, now.toISOString(), databaseOwnerId(ownerId), id]
    : ["pending", null, null, null, new Date(now.getTime() + 30_000).toISOString(), result.error, now.toISOString(), databaseOwnerId(ownerId), id];
  const [row] = await query<{ conversation_id: string }>(`update discord_automation_notifications set status=$1,discord_channel_id=$2,discord_message_id=$3,delivered_at=$4,next_attempt_at=coalesce($5,next_attempt_at),last_error=$6,lease_expires_at=null,updated_at=$7
    where owner_id=$8 and id=$9 and status='delivering' returning conversation_id`, params);
  return row ? { conversationId: String(row.conversation_id) } : null;
}

export async function getDeliveringDiscordAutomationNotification(
  ownerId: string,
  id: string,
): Promise<{ conversationId: string } | null> {
  const [row] = await query<{ conversation_id: string }>("select conversation_id from discord_automation_notifications where owner_id=$1 and id=$2 and status='delivering'", [databaseOwnerId(ownerId), id]);
  return row ? { conversationId: String(row.conversation_id) } : null;
}
