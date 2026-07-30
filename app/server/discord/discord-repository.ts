import "server-only";

import type { DiscordInboundMessage, DiscordSubmission } from "../../../lib/discord-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";

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
  const { data, error } = await getServerClient().from("discord_dm_messages").insert({
    owner_id: ownerId,
    discord_message_id: input.messageId,
    discord_user_id: input.userId,
    discord_channel_id: input.channelId,
    response_message_id: input.responseMessageId,
    content: input.content,
    attachments: input.attachments,
    status: "processing",
  }).select("discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output").single();
  if (!error) return { claimed: true, submission: submission(data as DiscordMessageRow) };
  if (error.code !== "23505") throw error;
  const existing = await getDiscordSubmission(ownerId, input.messageId);
  if (!existing) throw error;
  return { claimed: false, submission: existing };
}

export async function activeDiscordConversation(
  ownerId: string,
  userId: string,
  channelId: string,
): Promise<string | null> {
  const { data, error } = await getServerClient().from("discord_dm_channels")
    .select("active_conversation_id")
    .eq("owner_id", ownerId)
    .eq("discord_user_id", userId)
    .eq("discord_channel_id", channelId)
    .maybeSingle();
  if (error) throw error;
  return data?.active_conversation_id ?? null;
}

export async function setActiveDiscordConversation(
  ownerId: string,
  userId: string,
  channelId: string,
  conversationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getServerClient().from("discord_dm_channels").upsert({
    owner_id: ownerId,
    discord_user_id: userId,
    discord_channel_id: channelId,
    active_conversation_id: conversationId,
    updated_at: now,
  }, { onConflict: "owner_id,discord_channel_id" });
  if (error) throw error;
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
  const { error } = await getServerClient().from("discord_dm_messages").update(row)
    .eq("owner_id", ownerId).eq("discord_message_id", messageId);
  if (error) throw error;
}

export async function getDiscordSubmission(ownerId: string, messageId: string): Promise<DiscordSubmission | null> {
  const { data, error } = await getServerClient().from("discord_dm_messages")
    .select("discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output")
    .eq("owner_id", ownerId).eq("discord_message_id", messageId).maybeSingle();
  if (error) throw error;
  return data ? submission(data as DiscordMessageRow) : null;
}

export async function listPendingDiscordSubmissions(ownerId: string): Promise<DiscordSubmission[]> {
  const { data, error } = await getServerClient().from("discord_dm_messages")
    .select("discord_message_id,discord_channel_id,response_message_id,conversation_id,job_id,status,error,output")
    .eq("owner_id", ownerId).is("delivered_at", null).order("created_at").limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => submission(row as DiscordMessageRow));
}

export async function markDiscordDelivered(ownerId: string, messageId: string): Promise<void> {
  const { error } = await getServerClient().from("discord_dm_messages")
    .update({ delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId).eq("discord_message_id", messageId);
  if (error) throw error;
}
