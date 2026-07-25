import "server-only";
import type { ChatJobResumeResponse, ChatJobStatus, ChatRequest, ChatStreamEvent, ChatUsage } from "../../../lib/chat-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { createAsyncBatchWriter, type AsyncBatchWriter } from "./chat-event-writer";
import { ensureChatSubmission, finalizeChatJobMessage } from "./chat-history-store";

const table = () => getServerClient();
const CHAT_EVENT_BATCH_SIZE = 32;
const CHAT_EVENT_FLUSH_INTERVAL_MS = 100;

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

async function appendChatJobEvents(
  ownerId: string,
  conversationId: string,
  jobId: string,
  events: readonly ChatStreamEvent[],
): Promise<void> {
  if (!events.length) return;
  const client = table();
  const { error } = await client.from("chat_job_events").insert(
    events.map((event) => ({ owner_id: ownerId, conversation_id: conversationId, job_id: jobId, event })),
  );
  // A deleted conversation removes its job row while a worker may still be
  // between cancellation polls. Treat the resulting foreign-key failure as
  // a dropped event; the next cancellation poll stops the worker.
  if (error) {
    if (error.code === "23503") return;
    throw error;
  }
  const { error: updateError } = await client
    .from("chat_jobs")
    .update({ updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("job_id", jobId);
  if (updateError) throw updateError;
}

export function createChatJobEventWriter(
  ownerId: string,
  conversationId: string,
  jobId: string,
): AsyncBatchWriter<ChatStreamEvent> {
  return createAsyncBatchWriter(
    (events) => appendChatJobEvents(ownerId, conversationId, jobId, events),
    { batchSize: CHAT_EVENT_BATCH_SIZE, flushIntervalMs: CHAT_EVENT_FLUSH_INTERVAL_MS },
  );
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

export async function cancelChatJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await table()
    .from("chat_jobs")
    .update({ status: "cancelled", completed_at: now, updated_at: now })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .in("status", ["queued", "running"])
    .select("job_id");
  if (error) throw error;
  await Promise.all(
    (data ?? []).map((row) => finalizeChatJobMessage(ownerId, conversationId, row.job_id as string, "cancelled")),
  );
}

export async function deleteChatJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const { error } = await table()
    .from("chat_jobs")
    .delete()
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (error) throw error;
}

export async function isChatJobCancelled(ownerId: string, conversationId: string, jobId: string) {
  const { data } = await table().from("chat_jobs").select("status").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).maybeSingle();
  return !data || data.status === "cancelled";
}
