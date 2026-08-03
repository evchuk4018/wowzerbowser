import "server-only";

import type { DiscordInboundMessage, DiscordSubmission } from "../../../lib/discord-protocol";
import { databaseOwnerId, jsonb, query } from "../database/database";

type DiscordMessageRow = {
  discord_message_id: string;
  discord_channel_id: string;
  response_message_id: string;
  conversation_id: string | null;
  job_id: string | null;
  status: DiscordSubmission["status"];
  error: string | null;
  output: string | null;
};

const submission = (row: DiscordMessageRow): DiscordSubmission => ({
  messageId: row.discord_message_id,
  channelId: row.discord_channel_id,
  responseMessageId: row.response_message_id,
  conversationId: row.conversation_id,
  jobId: row.job_id,
  status: row.status,
  error: row.error,
  output: row.output,
});

export async function claimDiscordMessage(
  ownerId: string,
  input: DiscordInboundMessage,
): Promise<{ claimed: boolean; submission: DiscordSubmission }> {
  try {
    const [data] = await query<DiscordMessageRow>(`insert into discord_dm_messages(owner_id,discord_message_id,discord_user_id,discord_channel_id,response_message_id,content,attachments,status)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,'processing')
      returning discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output`, [databaseOwnerId(ownerId), input.messageId, input.userId, input.channelId, input.responseMessageId, input.content, jsonb(input.attachments)]);
    return { claimed: true, submission: submission(data) };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
  }
  const existing = await getDiscordSubmission(ownerId, input.messageId);
  if (!existing) throw new Error("Discord submission already exists but could not be loaded.");
  return { claimed: false, submission: existing };
}

export async function activeDiscordConversation(
  ownerId: string,
  userId: string,
  channelId: string,
): Promise<string | null> {
  const [row] = await query<{ active_conversation_id: string }>("select active_conversation_id from discord_dm_channels where owner_id=$1 and discord_user_id=$2 and discord_channel_id=$3", [databaseOwnerId(ownerId), userId, channelId]);
  return row?.active_conversation_id ?? null;
}

export async function setActiveDiscordConversation(
  ownerId: string,
  userId: string,
  channelId: string,
  conversationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await query(`insert into discord_dm_channels(owner_id,discord_user_id,discord_channel_id,active_conversation_id,updated_at)
    values($1,$2,$3,$4,$5) on conflict(owner_id,discord_channel_id) do update set discord_user_id=excluded.discord_user_id,active_conversation_id=excluded.active_conversation_id,updated_at=excluded.updated_at`, [databaseOwnerId(ownerId), userId, channelId, conversationId, now]);
}

export async function updateDiscordSubmission(
  ownerId: string,
  messageId: string,
  values: Partial<Pick<DiscordSubmission, "conversationId" | "jobId" | "status" | "error" | "output">>,
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("conversationId" in values) row.conversation_id = values.conversationId;
  if ("jobId" in values) row.job_id = values.jobId;
  if ("status" in values) row.status = values.status;
  if ("error" in values) row.error = values.error;
  if ("output" in values) row.output = values.output;
  const fields = Object.entries(row).filter(([key]) => key !== "updated_at");
  const params = [databaseOwnerId(ownerId), messageId, ...fields.map(([, value]) => value), row.updated_at];
  const set = fields.map(([key], index) => `${key}=$${index + 3}`).join(",");
  await query(`update discord_dm_messages set ${set},updated_at=$${params.length} where owner_id=$1 and discord_message_id=$2`, params);
}

export async function getDiscordSubmission(ownerId: string, messageId: string): Promise<DiscordSubmission | null> {
  const [row] = await query<DiscordMessageRow>("select discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output from discord_dm_messages where owner_id=$1 and discord_message_id=$2", [databaseOwnerId(ownerId), messageId]);
  return row ? submission(row) : null;
}

export async function listPendingDiscordSubmissions(ownerId: string): Promise<DiscordSubmission[]> {
  const rows = await query<DiscordMessageRow>("select discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output from discord_dm_messages where owner_id=$1 and delivered_at is null order by created_at limit 100", [databaseOwnerId(ownerId)]);
  return rows.map(submission);
}

export async function markDiscordDelivered(ownerId: string, messageId: string): Promise<void> {
  await query("update discord_dm_messages set delivered_at=$1,updated_at=$1 where owner_id=$2 and discord_message_id=$3", [new Date().toISOString(), databaseOwnerId(ownerId), messageId]);
}
