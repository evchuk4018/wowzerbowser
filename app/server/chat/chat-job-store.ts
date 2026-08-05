import "server-only";

import { randomUUID } from "node:crypto";
import type { ChatJobResumeResponse, ChatJobStatus, ChatRequest, ChatStreamEvent, ChatStreamMetrics, ChatUsage, DeepResearchPlan } from "../../../lib/chat-protocol";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";
import { createAsyncBatchWriter, type AsyncBatchWriter } from "./chat-event-writer";
import { authoritativeAttachmentsForSubmission } from "./chat-history-store";
import { CHAT_JOB_LEASE_MS, CHAT_JOB_MAX_ATTEMPTS } from "./chat-job-lease";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

const CHAT_EVENT_BATCH_SIZE = 32;
const CHAT_EVENT_FLUSH_INTERVAL_MS = 16;
const CHAT_EVENT_PAGE_SIZE = 1000;

type RpcRow = { result: unknown };

export type PersistedChatJobEvent = {
  eventIndex: number;
  event: ChatStreamEvent;
};

export type ChatJobClaim = {
  conversationId: string;
  jobId: string;
  status: ChatJobStatus;
  request?: ChatRequest;
  leaseToken: string;
  error: string | null;
  nextEventIndex: number;
};

export async function createOrGetChatJob(ownerId: string, request: ChatRequest) {
  const requestedAttachments = request.messages.at(-1)?.attachments?.length
    ? await authoritativeAttachmentsForSubmission(ownerId, request)
    : [];
  if (requestedAttachments.length !== new Set(request.messages.at(-1)?.attachments?.map((attachment) => attachment.id) ?? []).size) {
    throw new Error("Chat image metadata is invalid.");
  }
  const owner = databaseOwnerId(ownerId);
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select submit_and_claim_chat_job($1,$2::jsonb,$3::jsonb) as result",
    [owner, jsonb(request), jsonb(requestedAttachments)],
  ));
  return row.result as { jobId: string; status: ChatJobStatus; resumed: boolean; request?: ChatRequest };
}

export async function claimChatJob(ownerId: string, conversationId: string, jobId: string) {
  const workerToken = randomUUID();
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select claim_chat_job($1,$2,$3,$4::uuid,$5,$6) as result",
    [databaseOwnerId(ownerId), conversationId, jobId, workerToken, CHAT_JOB_LEASE_MS, CHAT_JOB_MAX_ATTEMPTS],
  ));
  const claim = row.result as { claimed?: boolean; status?: ChatJobStatus | "missing"; request?: ChatRequest; leaseToken?: string; error?: string; nextEventIndex?: number } | null;
  if (!claim?.claimed) return null;
  return {
    conversationId,
    jobId,
    status: claim.status as ChatJobStatus,
    request: claim.request as ChatRequest | undefined,
    leaseToken: claim.leaseToken ?? workerToken,
    error: claim.error ?? null,
    nextEventIndex: Number(claim.nextEventIndex ?? 1),
  };
}

/** Claim the oldest queued or expired chat atomically for the real worker. */
export async function claimNextChatJob(ownerId: string): Promise<ChatJobClaim | null> {
  const workerToken = randomUUID();
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select claim_next_chat_job($1,$2::uuid,$3,$4) as result",
    [databaseOwnerId(ownerId), workerToken, CHAT_JOB_LEASE_MS, CHAT_JOB_MAX_ATTEMPTS],
  ));
  const claim = row.result as {
    claimed?: boolean;
    status?: ChatJobStatus | "empty" | "missing";
    conversationId?: string;
    jobId?: string;
    request?: ChatRequest;
    leaseToken?: string;
    error?: string;
    nextEventIndex?: number;
  } | null;
  if (!claim?.claimed || !claim.conversationId || !claim.jobId) return null;
  return {
    conversationId: claim.conversationId,
    jobId: claim.jobId,
    status: claim.status as ChatJobStatus,
    request: claim.request,
    leaseToken: claim.leaseToken ?? workerToken,
    error: claim.error ?? null,
    nextEventIndex: Number(claim.nextEventIndex ?? 1),
  };
}

export async function renewChatJob(ownerId: string, conversationId: string, jobId: string, leaseToken: string) {
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select heartbeat_chat_job($1,$2,$3,$4::uuid,$5) as result",
    [databaseOwnerId(ownerId), conversationId, jobId, leaseToken, CHAT_JOB_LEASE_MS],
  ));
  return row.result as { active: boolean; status: ChatJobStatus | "missing"; cancelled?: boolean };
}

async function appendChatJobEvents(
  ownerId: string,
  conversationId: string,
  jobId: string,
  leaseToken: string,
  events: readonly PersistedChatJobEvent[],
): Promise<void> {
  if (!events.length) return;
  await withChatPersistenceRetry(() => query(
    "select append_chat_job_events($1,$2,$3,$4::uuid,$5::jsonb) as inserted",
    [databaseOwnerId(ownerId), conversationId, jobId, leaseToken, jsonb(events.map(({ eventIndex, event }) => ({ eventId: `${jobId}:${eventIndex}`, eventIndex, event })))],
  ).then(() => undefined));
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

export async function finishChatJob(ownerId: string, conversationId: string, jobId: string, leaseToken: string, status: ChatJobStatus, values: { error?: string | null; usage?: ChatUsage | null; finalOutput?: string | null; providerMetrics?: ChatStreamMetrics | null } = {}) {
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select complete_chat_job_and_finalize_message($1,$2,$3,$4::uuid,$5,$6,$7::jsonb,$8,$9::jsonb) as result",
    [databaseOwnerId(ownerId), conversationId, jobId, leaseToken, status, values.error ?? null, jsonb(values.usage ?? null), values.finalOutput ?? null, jsonb(values.providerMetrics ?? null)],
  ));
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function getChatJob(ownerId: string, conversationId: string, jobId: string, after = 0): Promise<ChatJobResumeResponse | null> {
  const databaseOwner = databaseOwnerId(ownerId);
  const [jobRows, eventRows] = await Promise.all([
    query<{ job_id: string; conversation_id: string; status: ChatJobStatus; error: string | null; usage: unknown; provider_metrics: unknown; final_output: string | null; created_at: unknown; updated_at: unknown }>(
      "select job_id,conversation_id,status,error,usage,provider_metrics,final_output,created_at,updated_at from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3",
      [databaseOwner, conversationId, jobId],
    ),
    query<{ event_index: number | string; event: ChatStreamEvent }>(
      "select event_index,event from chat_job_events where owner_id=$1 and conversation_id=$2 and job_id=$3 and event_index>$4 order by event_index limit $5",
      [databaseOwner, conversationId, jobId, after, CHAT_EVENT_PAGE_SIZE + 1],
    ),
  ]);
  const job = jobRows[0];
  if (!job) return null;
  const hasMore = eventRows.length > CHAT_EVENT_PAGE_SIZE;
  const events = eventRows.slice(0, CHAT_EVENT_PAGE_SIZE).map((row) => ({
    ...(row.event as ChatStreamEvent),
    sequence: Number(row.event_index),
    jobId,
  }));
  const annotationEvent = [...events].reverse().find((event) => event.type === "annotations");
  return {
    jobId,
    conversationId,
    status: job.status,
    events,
    hasMore,
    lastSequence: events.at(-1)?.sequence ?? after,
    error: job.error,
    usage: job.usage as ChatUsage | null,
    providerMetrics: job.provider_metrics as ChatStreamMetrics | null,
    finalOutput: job.final_output,
    ...(annotationEvent?.type === "annotations" ? { annotations: annotationEvent.annotations, sources: annotationEvent.sources } : {}),
    createdAt: isoTimestamp(job.created_at),
    updatedAt: isoTimestamp(job.updated_at),
  };
}

export async function cancelChatJob(ownerId: string, conversationId: string, jobId: string) {
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select cancel_chat_job_and_finalize_message($1,$2,$3) as result",
    [databaseOwnerId(ownerId), conversationId, jobId],
  ));
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function cancelChatJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const rows = await query<{ job_id: string }>(
    "select job_id from chat_jobs where owner_id=$1 and conversation_id=$2 and status=any($3::text[])",
    [databaseOwnerId(ownerId), conversationId, ["queued", "running", "awaiting_approval"]],
  );
  await Promise.all(rows.map((row) => cancelChatJob(ownerId, conversationId, row.job_id)));
}

export async function setChatJobAwaitingApproval(ownerId: string, conversationId: string, jobId: string, leaseToken?: string): Promise<void> {
  await query("update chat_jobs set status='awaiting_approval',lease_expires_at=null,lease_token=null,heartbeat_at=$1,updated_at=$1 where owner_id=$2 and conversation_id=$3 and job_id=$4 and status='running' and ($5::uuid is null or lease_token=$5::uuid)", [new Date().toISOString(), databaseOwnerId(ownerId), conversationId, jobId, leaseToken ?? null]);
}

export async function saveChatJobResearchPlan(ownerId: string, conversationId: string, jobId: string, plan: DeepResearchPlan): Promise<void> {
  await query("update chat_jobs set request=jsonb_set(request,'{deepResearchPlan}', $1::jsonb, true),updated_at=$2 where owner_id=$3 and conversation_id=$4 and job_id=$5 and status='running'", [jsonb(plan), new Date().toISOString(), databaseOwnerId(ownerId), conversationId, jobId]);
}

export async function resumeChatJobAfterApproval(ownerId: string, conversationId: string, jobId: string): Promise<void> {
  await query("update chat_jobs set status='queued',request=jsonb_set(request,'{deepResearchPhase}','\"execute\"'::jsonb,true),updated_at=$1 where owner_id=$2 and conversation_id=$3 and job_id=$4 and status='awaiting_approval'", [new Date().toISOString(), databaseOwnerId(ownerId), conversationId, jobId]);
}

export async function deleteChatJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  await query("delete from chat_jobs where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
}
