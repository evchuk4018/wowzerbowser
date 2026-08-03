import "server-only";

import { randomUUID } from "node:crypto";
import {
  CHAT_IMAGE_UPLOAD_TIMEOUT_MS,
  type ChatImageAttachment,
  type ChatImageContentType,
  ChatImageError,
  validateChatImageBytes,
} from "../../../lib/chat-image";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";
import { isStorageObjectId, validateStorageObjectKey, type StorageObject } from "../../../lib/storage-protocol";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import { getStorageObjectById, getStorageObjectByKey } from "../storage/storage-repository";
import { deleteOwnedStorageObject, writePendingStorageObject } from "../storage/storage-service";

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHAT_IMAGE_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const CHAT_IMAGE_PRE_SEND_RETENTION_MS = 30 * 60 * 1_000;
const STORAGE_PAGE_SIZE = 1_000;

export type ChatImageUploadRecord = {
  ownerId: string;
  conversationId: string;
  imageId: string;
  userMessageId: string;
  jobId: string | null;
  storagePath: string;
  storageObjectId: string;
  name: string | null;
  contentType: ChatImageContentType;
  size: number;
  contentHash: string | null;
  status: "processing" | "complete" | "failed";
  analysis: ChatImageAttachment["analysis"] | null;
  error: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  updatedAt: string;
};

export type ChatImageUploadIdentity = {
  ownerId: string;
  conversationId: string;
  imageId: string;
  userMessageId: string;
  jobId: string | null;
  storagePath: string;
  storageObjectId: string;
  name: string | null;
  contentType: ChatImageContentType;
  size: number;
  contentHash: string | null;
};

function recordFromRow(row: Record<string, unknown>, storageOwnerId: string): ChatImageUploadRecord {
  return {
    ownerId: storageOwnerId,
    conversationId: String(row.conversation_id),
    imageId: String(row.image_id),
    userMessageId: String(row.user_message_id),
    jobId: typeof row.job_id === "string" ? row.job_id : null,
    storagePath: String(row.storage_path),
    storageObjectId: typeof row.storage_object_id === "string" ? row.storage_object_id : "",
    name: typeof row.name === "string" ? row.name : null,
    contentType: row.content_type as ChatImageContentType,
    size: Number(row.size),
    contentHash: typeof row.content_hash === "string" ? row.content_hash : null,
    status: row.status as ChatImageUploadRecord["status"],
    analysis: row.analysis && typeof row.analysis === "object" ? row.analysis as ChatImageAttachment["analysis"] : null,
    error: typeof row.error === "string" ? row.error : null,
    claimToken: typeof row.claim_token === "string" ? row.claim_token : null,
    claimExpiresAt: row.claim_expires_at == null ? null : isoTimestamp(row.claim_expires_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export function attachmentFromUploadRecord(record: ChatImageUploadRecord): ChatImageAttachment | null {
  try {
    validateStorageObjectKey(record.storagePath);
  } catch {
    return null;
  }
  if (
    record.status !== "complete"
    || !record.analysis
    || record.analysis.status !== "complete"
    || !isStorageObjectId(record.storageObjectId)
  ) return null;
  return {
    id: record.imageId,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    storagePath: record.storagePath,
    analysis: record.analysis,
  };
}

export function chatImageUploadIdentityMatches(
  record: ChatImageUploadRecord,
  expected: ChatImageUploadIdentity,
): boolean {
  return record.ownerId === expected.ownerId
    && record.conversationId === expected.conversationId
    && record.imageId === expected.imageId
    && record.userMessageId === expected.userMessageId
    && record.jobId === expected.jobId
    && record.storagePath === expected.storagePath
    && record.storageObjectId === expected.storageObjectId
    && record.name === expected.name
    && record.contentType === expected.contentType
    && record.size === expected.size
    && record.contentHash === expected.contentHash;
}

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) throw new ChatImageError("invalid_id", `${field} is invalid.`);
}

export async function ensureChatImageConversation(ownerId: string, conversationId: string): Promise<void> {
  assertId(conversationId, "conversationId");
  try {
    await query("insert into chat_conversations(owner_id,conversation_id,title) values($1,$2,'New conversation') on conflict(owner_id,conversation_id) do nothing", [databaseOwnerId(ownerId), conversationId]);
  } catch {
    throw new ChatImageError("storage", "Chat storage is unavailable.", 503);
  }
}

export async function getChatImageUploadRecord(ownerId: string, conversationId: string, imageId: string): Promise<ChatImageUploadRecord | null> {
  assertId(conversationId, "conversationId");
  assertId(imageId, "imageId");
  try {
    const [data] = await query<Record<string, unknown>>("select * from chat_image_uploads where owner_id=$1 and conversation_id=$2 and image_id=$3", [databaseOwnerId(ownerId), conversationId, imageId]);
    return data ? recordFromRow(data, ownerId) : null;
  } catch {
    throw new ChatImageError("storage", "Image upload metadata is unavailable.", 503);
  }
}

export async function listChatImageUploadRecords(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  jobId: string;
  imageIds?: readonly string[];
  status?: ChatImageUploadRecord["status"];
}): Promise<ChatImageUploadRecord[]> {
  assertId(input.conversationId, "conversationId");
  assertId(input.userMessageId, "userMessageId");
  assertId(input.jobId, "jobId");
  const parameters: unknown[] = [databaseOwnerId(input.ownerId), input.conversationId, input.userMessageId, input.jobId];
  let statement = "select * from chat_image_uploads where owner_id=$1 and conversation_id=$2 and user_message_id=$3 and job_id=$4";
  if (input.status) {
    parameters.push(input.status);
    statement += ` and status=$${parameters.length}`;
  }
  if (input.imageIds?.length) {
    parameters.push([...input.imageIds]);
    statement += ` and image_id=any($${parameters.length}::text[])`;
  }
  try {
    const data = await query<Record<string, unknown>>(statement, parameters);
    return data.map((row) => recordFromRow(row, input.ownerId));
  } catch {
    throw new ChatImageError("storage", "Image upload metadata is unavailable.", 503);
  }
}

export async function claimChatImageUpload(input: {
  ownerId: string;
  conversationId: string;
  imageId: string;
  userMessageId: string;
  jobId?: string;
  storagePath: string;
  storageObjectId: string;
  name: string | null;
  contentType: ChatImageContentType;
  size: number;
  contentHash?: string;
}): Promise<{ record: ChatImageUploadRecord; claimed: boolean }> {
  assertId(input.conversationId, "conversationId");
  assertId(input.userMessageId, "userMessageId");
  assertId(input.imageId, "imageId");
  if (input.jobId) assertId(input.jobId, "jobId");
  const owner = databaseOwnerId(input.ownerId);
  try { validateStorageObjectKey(input.storagePath); } catch { throw new ChatImageError("image_id_conflict", "That image ID is bound to invalid storage.", 409); }
  if (!isStorageObjectId(input.storageObjectId)) throw new ChatImageError("image_id_conflict", "That image ID is bound to invalid storage.", 409);
  const expectedIdentity: ChatImageUploadIdentity = {
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    imageId: input.imageId,
    userMessageId: input.userMessageId,
    jobId: input.jobId ?? null,
    storagePath: input.storagePath,
    storageObjectId: input.storageObjectId,
    name: input.name,
    contentType: input.contentType,
    size: input.size,
    contentHash: input.contentHash ?? null,
  };
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(Date.now() + CHAT_IMAGE_CLAIM_LEASE_MS).toISOString();
  try {
    const [inserted] = await query<Record<string, unknown>>(`insert into chat_image_uploads(owner_id,conversation_id,image_id,user_message_id,job_id,storage_path,storage_object_id,name,content_type,size,content_hash,status,analysis,error,claim_token,claim_expires_at)
      values($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11,'processing',null,null,$12::uuid,$13) returning *`, [owner, input.conversationId, input.imageId, input.userMessageId, input.jobId ?? null, input.storagePath, input.storageObjectId, input.name, input.contentType, input.size, input.contentHash ?? null, claimToken, claimExpiresAt]);
    if (inserted) return { record: recordFromRow(inserted, input.ownerId), claimed: true };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw new ChatImageError("storage", "Image upload metadata could not be created.", 503);
  }
  const existing = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
  if (!existing) throw new ChatImageError("storage", "Image upload metadata could not be loaded.", 503);
  if (!chatImageUploadIdentityMatches(existing, expectedIdentity) && existing.status !== "failed") {
    throw new ChatImageError("image_id_conflict", "That image ID already belongs to different image data.", 409);
  }
  if (existing.status === "complete") return { record: existing, claimed: false };
  if (existing.status === "failed") {
    const [retried] = await query<Record<string, unknown>>(`update chat_image_uploads set status='processing',storage_path=$1,storage_object_id=$2::uuid,analysis=null,error=null,claim_token=$3::uuid,claim_expires_at=$4,updated_at=$5
      where owner_id=$6 and conversation_id=$7 and image_id=$8 and user_message_id=$9 and status='failed' and claim_token is null and job_id is not distinct from $10 returning *`, [input.storagePath, input.storageObjectId, claimToken, claimExpiresAt, new Date().toISOString(), owner, input.conversationId, input.imageId, input.userMessageId, input.jobId ?? null]);
    if (retried) return { record: recordFromRow(retried, input.ownerId), claimed: true };
    const current = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
    if (!current) throw new ChatImageError("storage", "Image upload metadata could not be claimed.", 503);
    return { record: current, claimed: false };
  }
  if (existing.status !== "processing") return { record: existing, claimed: false };
  const claimExpired = !existing.claimExpiresAt || Date.parse(existing.claimExpiresAt) <= Date.now();
  if (!claimExpired) return { record: existing, claimed: false };
  const [reclaimed] = await query<Record<string, unknown>>(`update chat_image_uploads set status='processing',content_hash=coalesce($1,content_hash),analysis=null,error=null,claim_token=$2::uuid,claim_expires_at=$3,updated_at=$4
    where owner_id=$5 and conversation_id=$6 and image_id=$7 and user_message_id=$8 and status='processing'
      and (claim_expires_at is null or claim_expires_at <= $4) and job_id is not distinct from $9 and claim_token is not distinct from $10::uuid returning *`, [input.contentHash ?? null, claimToken, claimExpiresAt, new Date().toISOString(), owner, input.conversationId, input.imageId, input.userMessageId, input.jobId ?? null, existing.claimToken]);
  if (!reclaimed) {
    const current = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
    if (!current) throw new ChatImageError("storage", "Image upload metadata could not be claimed.", 503);
    return { record: current, claimed: false };
  }
  return { record: recordFromRow(reclaimed, input.ownerId), claimed: true };
}

export async function completeChatImageUpload(
  ownerId: string,
  conversationId: string,
  imageId: string,
  claimToken: string,
  analysis: ChatImageAttachment["analysis"],
): Promise<ChatImageUploadRecord> {
  const [updated] = await query<Record<string, unknown>>(`update chat_image_uploads set status='complete',analysis=$1::jsonb,error=null,claim_token=null,claim_expires_at=null,updated_at=$2
    where owner_id=$3 and conversation_id=$4 and image_id=$5 and status='processing' and claim_token=$6::uuid returning *`, [jsonb(analysis), new Date().toISOString(), databaseOwnerId(ownerId), conversationId, imageId, claimToken]);
  if (updated) return recordFromRow(updated, ownerId);
  const current = await getChatImageUploadRecord(ownerId, conversationId, imageId);
  if (current?.status === "complete") return current;
  throw new ChatImageError("storage", "Image analysis metadata could not be saved.", 503);
}

export async function failChatImageUpload(ownerId: string, conversationId: string, imageId: string, claimToken: string, errorMessage: string): Promise<void> {
  await query("update chat_image_uploads set status='failed',analysis=null,error=$1,claim_token=null,claim_expires_at=null,updated_at=$2 where owner_id=$3 and conversation_id=$4 and image_id=$5 and status='processing' and claim_token=$6::uuid", [errorMessage.slice(0, 2_000), new Date().toISOString(), databaseOwnerId(ownerId), conversationId, imageId, claimToken]);
}

export async function releaseChatImageUploadClaim(ownerId: string, conversationId: string, imageId: string, claimToken: string): Promise<void> {
  await query(
    "update chat_image_uploads set claim_token=null,claim_expires_at=null,updated_at=$1 where owner_id=$2 and conversation_id=$3 and image_id=$4 and status='processing' and claim_token=$5::uuid",
    [new Date().toISOString(), databaseOwnerId(ownerId), conversationId, imageId, claimToken],
  );
}

/** Complete an image from the durable image worker, which owns the queue lease. */
export async function completeQueuedChatImageUpload(
  ownerId: string,
  conversationId: string,
  imageId: string,
  analysis: ChatImageAttachment["analysis"],
): Promise<ChatImageUploadRecord> {
  const [updated] = await query<Record<string, unknown>>(
    `update chat_image_uploads set status='complete',analysis=$1::jsonb,error=null,claim_token=null,claim_expires_at=null,updated_at=$2
     where owner_id=$3 and conversation_id=$4 and image_id=$5 and status='processing' returning *`,
    [jsonb(analysis), new Date().toISOString(), databaseOwnerId(ownerId), conversationId, imageId],
  );
  if (updated) return recordFromRow(updated, ownerId);
  const current = await getChatImageUploadRecord(ownerId, conversationId, imageId);
  if (current?.status === "complete") return current;
  throw new ChatImageError("storage", "Image analysis metadata could not be saved.", 503);
}

/** Mark a queued image failed when the worker lease or provider attempt is terminal. */
export async function failQueuedChatImageUpload(ownerId: string, conversationId: string, imageId: string, errorMessage: string): Promise<void> {
  await query(
    "update chat_image_uploads set status='failed',analysis=null,error=$1,claim_token=null,claim_expires_at=null,updated_at=$2 where owner_id=$3 and conversation_id=$4 and image_id=$5 and status='processing'",
    [errorMessage.slice(0, 2_000), new Date().toISOString(), databaseOwnerId(ownerId), conversationId, imageId],
  );
}

async function isActiveChatImageUpload(record: ChatImageUploadRecord): Promise<boolean> {
  if (!record.jobId) return false;
  try {
    const owner = databaseOwnerId(record.ownerId);
    const [[message], [job]] = await Promise.all([
      query<{ turn_id: string; version_id: string }>("select turn_id,version_id from chat_messages where owner_id=$1 and conversation_id=$2 and message_id=$3 and role='user'", [owner, record.conversationId, record.userMessageId]),
      query<{ request: unknown }>("select request from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, record.conversationId, record.jobId]),
    ]);
    const jobRequest = job?.request as {
    conversationId?: unknown;
    jobId?: unknown;
    persistence?: { turnId?: unknown; versionId?: unknown; userMessageId?: unknown };
    } | undefined;
    if (
      !message
      || jobRequest?.conversationId !== record.conversationId
      || jobRequest.jobId !== record.jobId
      || jobRequest.persistence?.userMessageId !== record.userMessageId
      || jobRequest.persistence?.turnId !== message.turn_id
      || jobRequest.persistence?.versionId !== message.version_id
    ) return false;

    const [[version], [turn], [assistant]] = await Promise.all([
      query<{ version_index: number }>("select version_index from chat_message_versions where owner_id=$1 and conversation_id=$2 and turn_id=$3 and version_id=$4", [owner, record.conversationId, message.turn_id, message.version_id]),
      query<{ active_version: number }>("select active_version from chat_turns where owner_id=$1 and conversation_id=$2 and turn_id=$3", [owner, record.conversationId, message.turn_id]),
      query<{ message_id: string }>("select message_id from chat_messages where owner_id=$1 and conversation_id=$2 and version_id=$3 and role='assistant' and job_id=$4", [owner, record.conversationId, message.version_id, record.jobId]),
    ]);
    return Boolean(version && turn && Number(version.version_index) === Number(turn.active_version) && assistant);
  } catch {
    throw new ChatImageError("storage", "Image metadata is unavailable.", 503);
  }
}

export async function cleanupExpiredChatImageUploads(ownerId: string, conversationId: string): Promise<void> {
  assertId(conversationId, "conversationId");
  const cutoff = new Date(Date.now() - CHAT_IMAGE_PRE_SEND_RETENTION_MS).toISOString();
  let data: Record<string, unknown>[];
  try {
    data = await query<Record<string, unknown>>("select * from chat_image_uploads where owner_id=$1 and conversation_id=$2 and updated_at < $3 and status <> 'processing' order by updated_at limit $4", [databaseOwnerId(ownerId), conversationId, cutoff, STORAGE_PAGE_SIZE]);
  } catch {
    throw new ChatImageError("cleanup_failed", "Expired image uploads could not be listed.", 503);
  }

  for (const row of data) {
    const record = recordFromRow(row, ownerId);
    if (await isActiveChatImageUpload(record)) continue;
    if (record.storageObjectId) await deleteOwnedStorageObject({ ownerId, objectId: record.storageObjectId });
    try {
      await query("delete from chat_image_uploads where owner_id=$1 and conversation_id=$2 and image_id=$3", [databaseOwnerId(ownerId), conversationId, record.imageId]);
    } catch {
      throw new ChatImageError("cleanup_failed", "Expired image upload metadata could not be removed.", 503);
    }
  }
}

export async function waitForChatImageUpload(ownerId: string, conversationId: string, imageId: string, signal?: AbortSignal): Promise<ChatImageUploadRecord | null> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (signal?.aborted) throw new ChatImageError("cancelled", "Image analysis was cancelled.", 499);
    const record = await getChatImageUploadRecord(ownerId, conversationId, imageId);
    if (!record || record.status !== "processing") return record;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (signal?.aborted) throw new ChatImageError("cancelled", "Image analysis was cancelled.", 499);
  return getChatImageUploadRecord(ownerId, conversationId, imageId);
}

export async function uploadChatImageObject(input: {
  ownerId: string;
  objectId: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<StorageObject> {
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId, state: "uploading" });
  if (!object || object.kind !== "image") throw new ChatImageError("upload_failed", "The image storage object was not found.", 503);
  const timeoutSignal = AbortSignal.timeout(CHAT_IMAGE_UPLOAD_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  if (signal?.aborted) throw new ChatImageError("cancelled", "Image upload was cancelled.", 499);
  try {
    return await writePendingStorageObject({ ownerId: input.ownerId, object, source: input.bytes, maxBytes: 10 * 1024 * 1024, signal });
  } catch (error) {
    if (input.signal?.aborted) throw new ChatImageError("cancelled", "Image upload was cancelled.", 499);
    if (timeoutSignal.aborted) throw new ChatImageError("upload_timeout", "Image upload timed out.", 408);
    throw error;
  }
}

export async function findChatImageAttachment(ownerId: string, conversationId: string, imageId: string): Promise<ChatImageAttachment> {
  assertId(conversationId, "conversationId");
  assertId(imageId, "imageId");
  const record = await getChatImageUploadRecord(ownerId, conversationId, imageId);
  const attachment = record && attachmentFromUploadRecord(record);
  if (attachment && await isActiveChatImageUpload(record)) return attachment;
  throw new ChatImageError("image_not_found", "The image was not found in this conversation.", 404);
}

/**
 * Resolves an owner-visible preview without requiring the optimistic chat turn
 * to have finished persisting. Model-facing callers must continue to use
 * findChatImageAttachment, which enforces active-turn membership.
 */
export async function findChatImagePreviewAttachment(ownerId: string, conversationId: string, imageId: string): Promise<ChatImageAttachment> {
  assertId(conversationId, "conversationId");
  assertId(imageId, "imageId");
  const record = await getChatImageUploadRecord(ownerId, conversationId, imageId);
  if (record?.status === "processing") {
    throw new ChatImageError("image_processing", "The image is still being prepared.", 409);
  }
  const attachment = record && attachmentFromUploadRecord(record);
  if (attachment) {
    const updatedAt = Date.parse(record.updatedAt);
    const withinPreSendWindow = Number.isFinite(updatedAt)
      && updatedAt >= Date.now() - CHAT_IMAGE_PRE_SEND_RETENTION_MS;
    if (withinPreSendWindow || await isActiveChatImageUpload(record)) return attachment;
  }
  throw new ChatImageError("image_not_found", "The image was not found in this conversation.", 404);
}

export async function downloadChatImageObject(ownerId: string, conversationId: string, image: ChatImageAttachment): Promise<Uint8Array> {
  const record = await getChatImageUploadRecord(ownerId, conversationId, image.id);
  if (!record || record.storagePath !== image.storagePath) {
    throw new ChatImageError("unauthorized_image", "That image is not available in this conversation.", 403);
  }
  const object = await getStorageObjectById({ ownerId, objectId: record.storageObjectId, conversationId, state: "complete" });
  if (!object || object.kind !== "image" || object.objectKey !== image.storagePath || object.contentType !== image.contentType || object.size !== image.size || (object.messageId !== null && object.messageId !== record.userMessageId)) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
  validateChatImageBytes(bytes, image.contentType);
  return bytes;
}

export async function openChatImageObject(ownerId: string, conversationId: string, image: ChatImageAttachment): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  const record = await getChatImageUploadRecord(ownerId, conversationId, image.id);
  if (!record || record.storagePath !== image.storagePath) throw new ChatImageError("unauthorized_image", "That image is not available in this conversation.", 403);
  const object = await getStorageObjectById({ ownerId, objectId: record.storageObjectId, conversationId, state: "complete" });
  if (!object || object.kind !== "image" || object.objectKey !== image.storagePath || object.contentType !== image.contentType || object.size !== image.size || (object.messageId !== null && object.messageId !== record.userMessageId)) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  const opened = await localFilesystemStorageProvider.readObject(object);
  if (opened.size !== object.size) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  return opened;
}

export async function downloadChatImageObjectByPath(ownerId: string, conversationId: string, path: string, contentType: ChatImageContentType): Promise<Uint8Array> {
  try { validateStorageObjectKey(path); } catch { throw new ChatImageError("storage_read_failed", "The image could not be read.", 503); }
  const object = await getStorageObjectByKey({ ownerId, conversationId, objectKey: path, state: "complete" });
  if (!object || object.kind !== "image" || object.contentType !== contentType) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
  if (bytes.byteLength !== object.size) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  validateChatImageBytes(bytes, contentType);
  return bytes;
}

export async function deleteStoredChatImages(paths: string[], ownerId = process.env.APP_OWNER_ID ?? ""): Promise<void> {
  const unique = [...new Set(paths.filter(Boolean))];
  for (const path of unique) {
    try { validateStorageObjectKey(path); } catch { throw new ChatImageError("cleanup_failed", "Stored images could not be removed.", 503); }
    const object = await getStorageObjectByKey({ ownerId, objectKey: path });
    if (object) await deleteOwnedStorageObject({ ownerId, objectId: object.objectId });
  }
}

export async function deleteChatImagesForConversation(ownerId: string, conversationId: string): Promise<void> {
  const rows = await query<{ storage_object_id: string | null }>("select storage_object_id from chat_image_uploads where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
  for (const row of rows) if (row.storage_object_id) await deleteOwnedStorageObject({ ownerId, objectId: row.storage_object_id });
}
