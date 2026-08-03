import "server-only";

import { randomUUID } from "node:crypto";
import { ChatDocumentError, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../../lib/chat-document";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";
import { getStorageObjectById } from "../storage/storage-repository";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

export const DOCUMENT_JOB_LEASE_MS = 15_000;
export const DOCUMENT_JOB_HEARTBEAT_MS = 5_000;
export const DOCUMENT_JOB_MAX_ATTEMPTS = 3;

export type DocumentProcessingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type DocumentProcessingProgress = {
  stage?: string;
  completed?: number;
  total?: number;
  pageNumber?: number;
};

export type DocumentProcessingJob = {
  ownerId: string;
  conversationId: string;
  jobId: string;
  documentId: string;
  storageObjectId: string;
  status: DocumentProcessingJobStatus;
  error: string | null;
  progress: DocumentProcessingProgress;
  document: ChatDocumentAttachment | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentProcessingJobClaim = DocumentProcessingJob & {
  leaseToken: string;
  request: {
    documentId: string;
    storageObjectId: string;
    filename: string;
    contentType: ChatDocumentAttachment["contentType"];
    userMessageId: string | null;
    sourceJobId: string | null;
  };
};

type RpcRow = { result: unknown };

function documentFromResult(value: unknown): ChatDocumentAttachment | null {
  if (!value || typeof value !== "object" || !("document" in value)) return null;
  const document = value.document;
  return document && typeof document === "object" ? document as ChatDocumentAttachment : null;
}

function progress(value: unknown): DocumentProcessingProgress {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.stage === "string" ? { stage: record.stage } : {}),
    ...(typeof record.completed === "number" && Number.isSafeInteger(record.completed) ? { completed: record.completed } : {}),
    ...(typeof record.total === "number" && Number.isSafeInteger(record.total) ? { total: record.total } : {}),
    ...(typeof record.pageNumber === "number" && Number.isSafeInteger(record.pageNumber) ? { pageNumber: record.pageNumber } : {}),
  };
}

function jobFromRow(row: Record<string, unknown>): DocumentProcessingJob {
  return {
    ownerId: String(row.owner_id),
    conversationId: String(row.conversation_id),
    jobId: String(row.job_id),
    documentId: String(row.document_id),
    storageObjectId: String(row.storage_object_id),
    status: row.status as DocumentProcessingJobStatus,
    error: typeof row.error === "string" ? row.error : null,
    progress: progress(row.progress),
    document: documentFromResult(row.result),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function claimFromResult(value: unknown): DocumentProcessingJobClaim | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.claimed !== true || typeof result.conversationId !== "string" || typeof result.jobId !== "string" || result.status !== "running") return null;
  const request = result.request;
  if (!request || typeof request !== "object" || typeof result.leaseToken !== "string") return null;
  const input = request as Record<string, unknown>;
  return {
    ownerId: "",
    conversationId: result.conversationId,
    jobId: result.jobId,
    documentId: String(result.documentId),
    storageObjectId: String(result.storageObjectId),
    status: "running",
    error: null,
    progress: progress(result.progress),
    document: null,
    createdAt: "",
    updatedAt: "",
    leaseToken: result.leaseToken,
    request: {
      documentId: String(input.documentId),
      storageObjectId: String(input.storageObjectId),
      filename: String(input.filename),
      contentType: input.contentType as ChatDocumentAttachment["contentType"],
      userMessageId: typeof input.userMessageId === "string" ? input.userMessageId : null,
      sourceJobId: typeof input.sourceJobId === "string" ? input.sourceJobId : null,
    },
  };
}

export async function enqueueDocumentProcessingJob(input: {
  ownerId: string;
  conversationId: string;
  documentId: string;
  storageObjectId: string;
  filename: string;
  contentType: ChatDocumentAttachment["contentType"];
  userMessageId: string;
  sourceJobId: string;
}): Promise<DocumentProcessingJob> {
  const object = await getStorageObjectById({
    ownerId: input.ownerId,
    objectId: input.storageObjectId,
    conversationId: input.conversationId,
    state: "complete",
  });
  if (!object || object.kind !== "document" || object.documentId !== input.documentId || object.contentType !== input.contentType) {
    throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is invalid.", 409);
  }
  if (object.size > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "Documents must be 25 MiB or smaller.", 413);
  const jobId = randomUUID();
  const idempotencyKey = `${input.documentId}:${input.storageObjectId}`;
  const filename = object.originalFilename ?? input.filename;
  const request = {
    documentId: input.documentId,
    storageObjectId: input.storageObjectId,
    filename,
    contentType: input.contentType,
    userMessageId: input.userMessageId,
    sourceJobId: input.sourceJobId,
  };
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select enqueue_document_processing_job($1,$2,$3,$4,$5,$6::uuid,$7::jsonb) as result",
    [databaseOwnerId(input.ownerId), input.conversationId, jobId, idempotencyKey, input.documentId, input.storageObjectId, jsonb(request)],
  ));
  const result = row.result as Record<string, unknown>;
  const [stored] = await query<Record<string, unknown>>(
    "select owner_id,conversation_id,job_id,document_id,storage_object_id,status,error,progress,result,created_at,updated_at from document_processing_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3",
    [databaseOwnerId(input.ownerId), input.conversationId, String(result.jobId)],
  );
  if (!stored) throw new Error("The document processing job could not be stored.");
  return jobFromRow(stored);
}

export async function getDocumentProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<DocumentProcessingJob | null> {
  const [row] = await query<Record<string, unknown>>(
    "select owner_id,conversation_id,job_id,document_id,storage_object_id,status,error,progress,result,created_at,updated_at from document_processing_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  return row ? jobFromRow(row) : null;
}

export async function claimNextDocumentProcessingJob(ownerId: string): Promise<DocumentProcessingJobClaim | null> {
  const workerToken = randomUUID();
  const [row] = await withChatPersistenceRetry(() => query<RpcRow>(
    "select claim_next_document_processing_job($1,$2::uuid,$3,$4) as result",
    [databaseOwnerId(ownerId), workerToken, DOCUMENT_JOB_LEASE_MS, DOCUMENT_JOB_MAX_ATTEMPTS],
  ));
  const claim = claimFromResult(row.result);
  if (!claim) return null;
  claim.ownerId = ownerId;
  return claim;
}

export async function heartbeatDocumentProcessingJob(
  ownerId: string,
  claim: Pick<DocumentProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  nextProgress?: DocumentProcessingProgress,
): Promise<{ active: boolean; status: DocumentProcessingJobStatus | "missing"; cancelled?: boolean }> {
  const [row] = await query<RpcRow>(
    "select heartbeat_document_processing_job($1,$2,$3,$4::uuid,$5,$6::jsonb) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, DOCUMENT_JOB_LEASE_MS, nextProgress ? jsonb(nextProgress) : null],
  );
  return row.result as { active: boolean; status: DocumentProcessingJobStatus | "missing"; cancelled?: boolean };
}

export async function updateDocumentProcessingProgress(
  ownerId: string,
  claim: Pick<DocumentProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  nextProgress: DocumentProcessingProgress,
): Promise<void> {
  await heartbeatDocumentProcessingJob(ownerId, claim, nextProgress);
}

export async function completeDocumentProcessingJob(
  ownerId: string,
  claim: Pick<DocumentProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  document: ChatDocumentAttachment,
  finalProgress: DocumentProcessingProgress,
): Promise<boolean> {
  const [row] = await query<RpcRow>(
    "select complete_document_processing_job($1,$2,$3,$4::uuid,$5::jsonb,$6::jsonb) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, jsonb({ document }), jsonb(finalProgress)],
  );
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function failDocumentProcessingJob(
  ownerId: string,
  claim: Pick<DocumentProcessingJobClaim, "conversationId" | "jobId" | "leaseToken">,
  error: string,
  retryable = true,
): Promise<void> {
  await query(
    "select fail_document_processing_job($1,$2,$3,$4::uuid,$5,$6,$7) as result",
    [databaseOwnerId(ownerId), claim.conversationId, claim.jobId, claim.leaseToken, error.slice(0, 500), retryable, DOCUMENT_JOB_MAX_ATTEMPTS],
  );
}

export async function cancelDocumentProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<boolean> {
  const [row] = await query<RpcRow>("select cancel_document_processing_job($1,$2,$3) as result", [databaseOwnerId(ownerId), conversationId, jobId]);
  return Boolean((row.result as { applied?: boolean } | null)?.applied);
}

export async function resumeDocumentProcessingJob(ownerId: string, conversationId: string, jobId: string): Promise<boolean> {
  const rows = await query(
    "update document_processing_jobs set status='queued',error=null,progress='{}'::jsonb,result=null,next_attempt_at=now(),completed_at=null,updated_at=now() where owner_id=$1 and conversation_id=$2 and job_id=$3 and status='failed'",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  return rows.length > 0;
}

export async function deleteDocumentProcessingJobsForDocument(ownerId: string, conversationId: string, documentId: string): Promise<void> {
  await query("delete from document_processing_jobs where owner_id=$1 and conversation_id=$2 and document_id=$3", [databaseOwnerId(ownerId), conversationId, documentId]);
}
