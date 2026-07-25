import "server-only";
import type { ChatJobResumeResponse, ChatJobStatus, ChatRequest, ChatStreamEvent, ChatUsage } from "../../../lib/chat-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { applyChatJobEvent, ensureChatSubmission, finalizeChatJobMessage } from "./chat-history-store";

const table = () => getServerClient();

export async function createOrGetChatJob(ownerId: string, request: ChatRequest) {
  const conversationId = request.conversationId!;
  const jobId = request.jobId!;
  const idempotencyKey = request.idempotencyKey!;
  await ensureChatSubmission(ownerId, request);
  const row = { owner_id: ownerId, conversation_id: conversationId, job_id: jobId, idempotency_key: idempotencyKey, request, status: "queued" };
  const { error } = await table().from("chat_jobs").insert(row);
  if (!error) return { jobId, status: "queued" as ChatJobStatus, resumed: false };
  if (error.code !== "23505") throw error;
  const { data, error: readError } = await table().from("chat_jobs").select("job_id,status").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("idempotency_key", idempotencyKey).single();
  if (readError) throw readError;
  return { jobId: data.job_id as string, status: data.status as ChatJobStatus, resumed: true };
}

export async function claimChatJob(ownerId: string, conversationId: string, jobId: string) {
  const now = new Date().toISOString();
  const { data, error } = await table().from("chat_jobs").update({ status: "running", started_at: now, updated_at: now }).eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).eq("status", "queued").select("request").maybeSingle();
  if (error) throw error;
  return (data?.request as ChatRequest | undefined) ?? null;
}

export async function appendChatJobEvent(ownerId: string, conversationId: string, jobId: string, event: ChatStreamEvent) {
  const client = table();
  const { data, error } = await client
    .from("chat_job_events")
    .insert({ owner_id: ownerId, conversation_id: conversationId, job_id: jobId, event })
    .select("sequence")
    .single();
  if (error) throw error;
  await applyChatJobEvent(ownerId, conversationId, jobId, event, Number(data.sequence));
  await client.from("chat_jobs").update({ updated_at: new Date().toISOString() }).eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId);
}

export async function finishChatJob(ownerId: string, conversationId: string, jobId: string, status: ChatJobStatus, values: { error?: string | null; usage?: ChatUsage | null; finalOutput?: string | null } = {}) {
  const now = new Date().toISOString();
  const { error } = await table().from("chat_jobs").update({ status, error: values.error ?? null, usage: values.usage ?? null, final_output: values.finalOutput ?? null, completed_at: now, updated_at: now }).eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId);
  if (error) throw error;
  await finalizeChatJobMessage(
    ownerId,
    conversationId,
    jobId,
    status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "error",
    values,
  );
}

export async function getChatJob(ownerId: string, conversationId: string, jobId: string, after = 0): Promise<ChatJobResumeResponse | null> {
  const client = table();
  const [jobResult, eventsResult] = await Promise.all([
    client.from("chat_jobs").select("job_id,conversation_id,status,error,usage,final_output,created_at,updated_at").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).maybeSingle(),
    client.from("chat_job_events").select("sequence,event").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).gt("sequence", after).order("sequence").limit(1000),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (!jobResult.data) return null;
  if (eventsResult.error) throw eventsResult.error;
  const events = (eventsResult.data ?? []).map((row) => ({ ...(row.event as ChatStreamEvent), sequence: Number(row.sequence), jobId }));
  return { jobId, conversationId, status: jobResult.data.status as ChatJobStatus, events, lastSequence: events.at(-1)?.sequence ?? after, error: jobResult.data.error, usage: jobResult.data.usage as ChatUsage | null, finalOutput: jobResult.data.final_output, createdAt: jobResult.data.created_at, updatedAt: jobResult.data.updated_at };
}

export async function cancelChatJob(ownerId: string, conversationId: string, jobId: string) {
  const now = new Date().toISOString();
  const { data, error } = await table().from("chat_jobs").update({ status: "cancelled", completed_at: now, updated_at: now }).eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).in("status", ["queued", "running"]).select("job_id").maybeSingle();
  if (error) throw error;
  if (data) await finalizeChatJobMessage(ownerId, conversationId, jobId, "cancelled");
  return Boolean(data);
}

export async function isChatJobCancelled(ownerId: string, conversationId: string, jobId: string) {
  const { data } = await table().from("chat_jobs").select("status").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).maybeSingle();
  return data?.status === "cancelled";
}
