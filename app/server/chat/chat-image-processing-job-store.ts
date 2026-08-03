import "server-only";

import { randomUUID } from "node:crypto";
import type { ChatImageAttachment, ChatImageContentType } from "../../../lib/chat-image";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

export const IMAGE_PROCESSING_JOB_LEASE_MS = 15_000;
export const IMAGE_PROCESSING_JOB_HEARTBEAT_MS = 5_000;
export const IMAGE_PROCESSING_JOB_MAX_ATTEMPTS = 3;

export type ChatImageProcessingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ChatImageProcessingProgress = { stage?: string };

export type ChatImageProcessingJob = {
  ownerId: string;
  conversationId: string;
  jobId: string;
  imageId: string;
  status: ChatImageProcessingJobStatus;
  error: string | null;
  progress: ChatImageProcessingProgress;
  attachment: ChatImageAttachment | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatImageProcessingJobClaim = ChatImageProcessingJob & {
  leaseToken: string;
  request: {
    imageId: string;
    userMessageId: string;
    chatJobId: string | null;
    storageObjectId: string;
    name: string | null;
    contentType: ChatImageContentType;
  };
};

type RpcRow = { result: unknown };

function progress(value: unknown): ChatImageProcessingProgress {
  if (!value || typeof value !== "object") return {};
  const stage = (value as Record<string, unknown>).stage;
  return typeof stage === "string" ? { stage } : {};
}

function attachmentFromResult(value: unknown): ChatImageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const attachment = (value as Record<string, unknown>).attachment;
  return attachment && typeof attachment === "object" ? attachment as ChatImageAttachment : null;
}

function jobFromRow(row: Record<string, unknown>, ownerId: string): ChatImageProcessingJob {
  return {
    ownerId,
    conversationId: String(row.conversation_id),
    jobId: String(row.job_id),
    imageId: String(row.image_id),
    status: row.status as ChatImageProcessingJobStatus,
    error: typeof row.error === "string" ? row.error : null,
    progress: progress(row.progress),
    attachment: attachmentFromResult(row.result),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function claimFromResult(value: unknown): ChatImageProcessingJobClaim | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.claimed !== true || result.status !== "running" || typeof result.conversationId !== "string" || typeof result.jobId !== "string" || typeof result.imageId !== "string" || typeof result.leaseToken !== "string") return null;
  const request = result.request;
  if (!request || typeof request !== "object") return null;
  const input = request as Record<string, unknown>;
  return {
    ownerId: "",
    conversationId: result.conversationId,
    jobId: result.jobId,
    imageId: result.imageId,
    status: "running",
    error: null,
    progress: progress(result.progress),
    attachment: null,
    createdAt: "",
    updatedAt: "",
    leaseToken: result.leaseToken,
    request: {
      imageId: String(input.imageId ?? result.imageId),
      userMessageId: String(input.userMessageId ?? result.userMessageId),
      chatJobId: typeof input.chatJobId === "string" ? input.chatJobId : null,
      storageObjectId: String(input.storageObjectId ?? result.storageObjectId),
      name: typeof input.name === "string" ? input.name : null,
      contentType: input.contentType as ChatImageContentType,
    },
  };
}

async function readJob(ownerId: string, conversationId: string, jobId: string): Promise<ChatImageProcessingJob | null> {
  const [row] = await query<Record<string, unknown>>(
    "select owner_id,conversation_id,job_id,image_id,status,error,progress,result,created_at,updated_at from chat_image_processing_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  return row ? jobFromRow(row, ownerId) : null;
}

export async function getChatImageProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<ChatImageProcessingJob | null> {
  return readJob(ownerId, conversationId, jobId);
}

export async function getChatImageProcessingJobForImage(ownerId: string, conversationId: string, imageId: string): Promise<ChatImageProcessingJob | null> {
  const [row] = await query<Record<string, unknown>>(
    "select owner_id,conversation_id,job_id,image_id,status,error,progress,result,created_at,updated_at from chat_image_processing_jobs where owner_id=$1 and conversation_id=$2 and image_id=$3 order by created_at desc limit 1",
    [databaseOwnerId(ownerId), conversationId, imageId],
  );
  return row ? jobFromRow(row, ownerId) : null;
}

export async function enqueueChatImageProcessingJob(input: {
  ownerId: string;
  conversationId: string;
  imageId: string;
  userMessageId: string;
  chatJobId: string | null;
  storageObjectId: string;
  name: string | null;
  contentType: ChatImageContentType;
}): Promise<ChatImageProcessingJob> {
  const jobId = randomUUID();
  const idempotencyKey = `${input.imageId}:${input.storageObjectId}`;
  const request = {
    imageId: input.imageId,
    userMessageId: input.userMessageId,
    chatJobId: input.chatJobId,
    storageObjectId: input.storageObjectId,
    name: input.name,
    contentType: input.contentType,
  };
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select enqueue_chat_image_processing_job($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::jsonb) as result",
    [databaseOwnerId(input.ownerId), input.conversationId, jobId, idempotencyKey, input.imageId, input.userMessageId, input.chatJobId, input.storageObjectId, jsonb(request)],
  ));
  const result = row.result as Record<string, unknown>;
  const stored = await readJob(input.ownerId, input.conversationId, String(result.jobId));
  if (!stored) throw new Error("The image processing job could not be stored.");
  return stored;
}

export async function claimNextChatImageProcessingJob(ownerId: string): Promise<ChatImageProcessingJobClaim | null> {
  const workerToken = randomUUID();
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select claim_next_chat_image_processing_job($1,$2::uuid,$3,$4) as result",
    [databaseOwnerId(ownerId), workerToken, IMAGE_PROCESSING_JOB_LEASE_MS, IMAGE_PROCESSING_JOB_MAX_ATTEMPTS],
  ));
  const claim = claimFromResult(row.result);
  if (!claim) return null;
  claim.ownerId = ownerId;
  return claim;
}

export async function heartbeatChatImageProcessingJob(
  ownerId: string,
  claim: Pick<ChatImageProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  nextProgress?: ChatImageProcessingProgress,
): Promise<{ active: boolean; status: ChatImageProcessingJobStatus | "missing"; cancelled?: boolean }> {
  const [row] = await query<RpcRow>(
    "select heartbeat_chat_image_processing_job($1,$2,$3,$4::uuid,$5,$6::jsonb) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, IMAGE_PROCESSING_JOB_LEASE_MS, nextProgress ? jsonb(nextProgress) : null],
  );
  return row.result as { active: boolean; status: ChatImageProcessingJobStatus | "missing"; cancelled?: boolean };
}

export async function completeChatImageProcessingJob(
  ownerId: string,
  claim: Pick<ChatImageProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  attachment: ChatImageAttachment,
  progressValue: ChatImageProcessingProgress,
): Promise<boolean> {
  const [row] = await query<RpcRow>(
    "select complete_chat_image_processing_job($1,$2,$3,$4::uuid,$5::jsonb,$6::jsonb) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, jsonb({ attachment }), jsonb(progressValue)],
  );
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function failChatImageProcessingJob(
  ownerId: string,
  claim: Pick<ChatImageProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  error: string,
  retryable = true,
): Promise<void> {
  await query(
    "select fail_chat_image_processing_job($1,$2,$3,$4::uuid,$5,$6,$7) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, error.slice(0, 500), retryable, IMAGE_PROCESSING_JOB_MAX_ATTEMPTS],
  );
}

export async function cancelChatImageProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<boolean> {
  const [row] = await query<RpcRow>(
    "select cancel_chat_image_processing_job($1,$2,$3) as result",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function resumeChatImageProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<boolean> {
  const [row] = await query<RpcRow>(
    "select resume_chat_image_processing_job($1,$2,$3) as result",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function deleteChatImageProcessingJobsForConversation(ownerId: string, conversationId: string): Promise<void> {
  await query("delete from chat_image_processing_jobs where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
}
