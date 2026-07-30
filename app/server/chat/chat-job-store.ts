import "server-only";
import { randomUUID } from "node:crypto";
import type { ChatJobResumeResponse, ChatJobStatus, ChatRequest, ChatStreamEvent, ChatUsage } from "../../../lib/chat-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { createAsyncBatchWriter, type AsyncBatchWriter } from "./chat-event-writer";
import { authoritativeAttachmentsForSubmission } from "./chat-history-store";
import { CHAT_JOB_LEASE_MS, CHAT_JOB_MAX_ATTEMPTS } from "./chat-job-lease";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

const table = () => getServerClient();
const CHAT_EVENT_BATCH_SIZE = 32;
const CHAT_EVENT_FLUSH_INTERVAL_MS = 100;
const CHAT_EVENT_PAGE_SIZE = 1000;

async function runRpc(name: string, args: Record<string, unknown>) {
  const result = await table().rpc(name, args);
  if (result.error) throw result.error;
  return result;
}

export type PersistedChatJobEvent = {
  eventIndex: number;
  event: ChatStreamEvent;
};

export async function createOrGetChatJob(ownerId: string, request: ChatRequest) {
  const requestedAttachments = request.messages.at(-1)?.attachments?.length
    ? await authoritativeAttachmentsForSubmission(ownerId, request)
    : [];
  if (requestedAttachments.length !== new Set(request.messages.at(-1)?.attachments?.map((attachment) => attachment.id) ?? []).size) {
    throw new Error("Chat image metadata is invalid.");
  }
  const { data, error } = await withChatPersistenceRetry(() => runRpc("submit_and_claim_chat_job", {
    p_owner_id: ownerId,
    p_request: request,
    p_attachments: requestedAttachments,
  }));
  if (error) throw error;
  return data as { jobId: string; status: ChatJobStatus; resumed: boolean; request?: ChatRequest };
}

export async function claimChatJob(ownerId: string, conversationId: string, jobId: string) {
  const workerToken = randomUUID();
  const { data, error } = await withChatPersistenceRetry(() => runRpc("claim_chat_job", {
    p_owner_id: ownerId,
    p_conversation_id: conversationId,
    p_job_id: jobId,
    p_worker_token: workerToken,
    p_lease_ms: CHAT_JOB_LEASE_MS,
    p_max_attempts: CHAT_JOB_MAX_ATTEMPTS,
  }));
  if (error) throw error;
  const claim = data as { claimed?: boolean; status?: ChatJobStatus | "missing"; request?: ChatRequest; leaseToken?: string; error?: string } | null;
  if (!claim?.claimed) return null;
  return {
    status: claim.status as ChatJobStatus,
    request: claim.request as ChatRequest | undefined,
    leaseToken: claim.leaseToken ?? workerToken,
    error: claim.error ?? null,
  };
}

export async function renewChatJob(ownerId: string, conversationId: string, jobId: string, leaseToken: string) {
  const { data, error } = await withChatPersistenceRetry(() => runRpc("heartbeat_chat_job", {
    p_owner_id: ownerId,
    p_conversation_id: conversationId,
    p_job_id: jobId,
    p_worker_token: leaseToken,
    p_lease_ms: CHAT_JOB_LEASE_MS,
  }));
  if (error) throw error;
  return data as { active: boolean; status: ChatJobStatus | "missing"; cancelled?: boolean };
}

async function appendChatJobEvents(
  ownerId: string,
  conversationId: string,
  jobId: string,
  leaseToken: string,
  events: readonly PersistedChatJobEvent[],
): Promise<void> {
  if (!events.length) return;
  await withChatPersistenceRetry(async () => {
    const { error } = await table().rpc("append_chat_job_events", {
      p_owner_id: ownerId,
      p_conversation_id: conversationId,
      p_job_id: jobId,
      p_worker_token: leaseToken,
      p_events: events.map(({ eventIndex, event }) => ({
        eventId: `${jobId}:${eventIndex}`,
        eventIndex,
        event,
      })),
    });
    if (error) throw error;
  });
}

export function createChatJobEventWriter(
  ownerId: string,
  conversationId: string,
  jobId: string,
  leaseToken: string,
): AsyncBatchWriter<PersistedChatJobEvent> {
  return createAsyncBatchWriter(
    (events) => appendChatJobEvents(ownerId, conversationId, jobId, leaseToken, events),
    { batchSize: CHAT_EVENT_BATCH_SIZE, flushIntervalMs: CHAT_EVENT_FLUSH_INTERVAL_MS },
  );
}

export async function finishChatJob(ownerId: string, conversationId: string, jobId: string, leaseToken: string, status: ChatJobStatus, values: { error?: string | null; usage?: ChatUsage | null; finalOutput?: string | null } = {}) {
  const { data, error } = await withChatPersistenceRetry(() => runRpc("complete_chat_job_and_finalize_message", {
    p_owner_id: ownerId,
    p_conversation_id: conversationId,
    p_job_id: jobId,
    p_worker_token: leaseToken,
    p_status: status,
    p_error: values.error ?? null,
    p_usage: values.usage ?? null,
    p_final_output: values.finalOutput ?? null,
  }));
  if (error) throw error;
  return Boolean((data as { applied?: boolean } | null)?.applied);
}

export async function getChatJob(ownerId: string, conversationId: string, jobId: string, after = 0): Promise<ChatJobResumeResponse | null> {
  const client = table();
  const [jobResult, eventsResult] = await Promise.all([
    client.from("chat_jobs").select("job_id,conversation_id,status,error,usage,final_output,created_at,updated_at").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).maybeSingle(),
    client.from("chat_job_events").select("event_index,event").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).gt("event_index", after).order("event_index").limit(CHAT_EVENT_PAGE_SIZE + 1),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (!jobResult.data) return null;
  if (eventsResult.error) throw eventsResult.error;
  const rows = eventsResult.data ?? [];
  const hasMore = rows.length > CHAT_EVENT_PAGE_SIZE;
  const events = rows.slice(0, CHAT_EVENT_PAGE_SIZE).map((row) => ({
    ...(row.event as ChatStreamEvent),
    sequence: Number(row.event_index),
    jobId,
  }));
  const annotationEvent = [...events].reverse().find((event) => event.type === "annotations");
  return { jobId, conversationId, status: jobResult.data.status as ChatJobStatus, events, hasMore, lastSequence: events.at(-1)?.sequence ?? after, error: jobResult.data.error, usage: jobResult.data.usage as ChatUsage | null, finalOutput: jobResult.data.final_output, ...(annotationEvent?.type === "annotations" ? { annotations: annotationEvent.annotations, sources: annotationEvent.sources } : {}), createdAt: jobResult.data.created_at, updatedAt: jobResult.data.updated_at };
}

export async function cancelChatJob(ownerId: string, conversationId: string, jobId: string) {
  const { data, error } = await withChatPersistenceRetry(() => runRpc("cancel_chat_job_and_finalize_message", {
    p_owner_id: ownerId,
    p_conversation_id: conversationId,
    p_job_id: jobId,
  }));
  if (error) throw error;
  return Boolean((data as { applied?: boolean } | null)?.applied);
}

export async function cancelChatJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const { data, error } = await table()
    .from("chat_jobs")
    .select("job_id")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .in("status", ["queued", "running", "awaiting_approval"]);
  if (error) throw error;
  await Promise.all(
    (data ?? []).map((row) => cancelChatJob(ownerId, conversationId, row.job_id as string)),
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
