import "server-only";

import { databaseOwnerId, query } from "../database/database";

export async function queueUserQuestionDiscordDelivery(input: { ownerId: string; questionId: string; question: string; context: string | null; conversationId: string | null }): Promise<void> {
  try {
    await query(
      `insert into discord_user_question_notifications(owner_id,user_question_id,question,context,conversation_id)
       values($1,$2,$3,$4,$5) on conflict(owner_id,user_question_id) do nothing`,
      [databaseOwnerId(input.ownerId), input.questionId, input.question, input.context, input.conversationId],
    );
  } catch {
    // Table may not exist pre-migration; best effort.
  }
}

export type DiscordUserQuestionNotification = {
  id: string;
  userQuestionId: string;
  question: string;
  context: string | null;
  conversationId: string | null;
  status: string;
  attemptCount: number;
};

export async function claimDiscordUserQuestionNotifications(ownerId: string, limit = 10): Promise<DiscordUserQuestionNotification[]> {
  try {
    const rows = await query<Record<string, unknown>>("select id,user_question_id,question,context,conversation_id,status,attempt_count from claim_discord_user_question_notifications($1,$2)", [databaseOwnerId(ownerId), limit]);
    return rows.map((row) => ({
      id: String(row.id),
      userQuestionId: String(row.user_question_id),
      question: String(row.question),
      context: row.context == null ? null : String(row.context),
      conversationId: row.conversation_id == null ? null : String(row.conversation_id),
      status: String(row.status),
      attemptCount: Number(row.attempt_count),
    }));
  } catch {
    return [];
  }
}

export async function finishDiscordUserQuestionNotification(ownerId: string, id: string, result: { status: "delivered" | "failed"; channelId?: string; messageId?: string; error?: string }): Promise<boolean> {
  try {
    if (result.status === "delivered") {
      const [row] = await query<{ id: string }>(
        `update discord_user_question_notifications set status='delivered',discord_channel_id=$1,discord_message_id=$2,delivered_at=$3,lease_expires_at=null,updated_at=$3 where owner_id=$4 and id=$5 and status='delivering' returning id`,
        [result.channelId ?? null, result.messageId ?? null, new Date().toISOString(), databaseOwnerId(ownerId), id],
      );
      return Boolean(row);
    }
    const [row] = await query<{ id: string }>(
      `update discord_user_question_notifications set status='pending',next_attempt_at=$1,last_error=$2,lease_expires_at=null,updated_at=$3 where owner_id=$4 and id=$5 and status='delivering' returning id`,
      [new Date(Date.now() + 30_000).toISOString(), result.error ?? null, new Date().toISOString(), databaseOwnerId(ownerId), id],
    );
    return Boolean(row);
  } catch {
    return false;
  }
}
