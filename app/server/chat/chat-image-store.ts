import "server-only";

import { randomUUID } from "node:crypto";
import {
  CHAT_IMAGE_BUCKET,
  CHAT_IMAGE_UPLOAD_TIMEOUT_MS,
  type ChatImageAttachment,
  type ChatImageContentType,
  ChatImageError,
  validateChatImageBytes,
} from "../../../lib/chat-image";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHAT_IMAGE_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const CHAT_IMAGE_PRE_SEND_RETENTION_MS = 30 * 60 * 1_000;
const STORAGE_PAGE_SIZE = 1_000;
const storage = () => getServerClient().storage.from(CHAT_IMAGE_BUCKET);

export type ChatImageUploadRecord = {
  ownerId: string;
  conversationId: string;
  imageId: string;
  userMessageId: string;
  jobId: string | null;
  storagePath: string;
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
  name: string | null;
  contentType: ChatImageContentType;
  size: number;
  contentHash: string | null;
};

function recordFromRow(row: Record<string, unknown>, storageOwnerId: string): ChatImageUploadRecord {
  return {
    // The database owner is the stable APP_OWNER_ID. Storage paths retain the
    // authenticated Supabase owner ID until the storage migration is complete.
    ownerId: storageOwnerId,
    conversationId: String(row.conversation_id),
    imageId: String(row.image_id),
    userMessageId: String(row.user_message_id),
    jobId: typeof row.job_id === "string" ? row.job_id : null,
    storagePath: String(row.storage_path),
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
  let expectedStoragePath: string;
  try {
    expectedStoragePath = chatImageStoragePath(record.ownerId, record.conversationId, record.userMessageId, record.imageId);
  } catch {
    return null;
  }
  if (
    record.status !== "complete"
    || !record.analysis
    || record.analysis.status !== "complete"
    || record.storagePath !== expectedStoragePath
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
    && record.name === expected.name
    && record.contentType === expected.contentType
    && record.size === expected.size
    && record.contentHash === expected.contentHash;
}

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) throw new ChatImageError("invalid_id", `${field} is invalid.`);
}

export function chatImageStoragePath(ownerId: string, conversationId: string, userMessageId: string, imageId: string): string {
  assertId(conversationId, "conversationId");
  assertId(userMessageId, "userMessageId");
  assertId(imageId, "imageId");
  return `${ownerId}/${conversationId}/${userMessageId}/${imageId}`;
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
  const expectedStoragePath = chatImageStoragePath(input.ownerId, input.conversationId, input.userMessageId, input.imageId);
  if (input.storagePath !== expectedStoragePath) {
    throw new ChatImageError("image_id_conflict", "That image ID is bound to different storage.", 409);
  }
  const expectedIdentity: ChatImageUploadIdentity = {
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    imageId: input.imageId,
    userMessageId: input.userMessageId,
    jobId: input.jobId ?? null,
    storagePath: input.storagePath,
    name: input.name,
    contentType: input.contentType,
    size: input.size,
    contentHash: input.contentHash ?? null,
  };
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(Date.now() + CHAT_IMAGE_CLAIM_LEASE_MS).toISOString();
  try {
    const [inserted] = await query<Record<string, unknown>>(`insert into chat_image_uploads(owner_id,conversation_id,image_id,user_message_id,job_id,storage_path,name,content_type,size,content_hash,status,analysis,error,claim_token,claim_expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing',null,null,$11::uuid,$12) returning *`, [owner, input.conversationId, input.imageId, input.userMessageId, input.jobId ?? null, input.storagePath, input.name, input.contentType, input.size, input.contentHash ?? null, claimToken, claimExpiresAt]);
    if (inserted) return { record: recordFromRow(inserted, input.ownerId), claimed: true };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw new ChatImageError("storage", "Image upload metadata could not be created.", 503);
  }
  const existing = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
  if (!existing) throw new ChatImageError("storage", "Image upload metadata could not be loaded.", 503);
  if (!chatImageUploadIdentityMatches(existing, expectedIdentity)) {
    throw new ChatImageError("image_id_conflict", "That image ID already belongs to different image data.", 409);
  }
  if (existing.status === "complete") return { record: existing, claimed: false };
  if (existing.status === "failed") {
    const [retried] = await query<Record<string, unknown>>(`update chat_image_uploads set status='processing',analysis=null,error=null,claim_token=$1::uuid,claim_expires_at=$2,updated_at=$3
      where owner_id=$4 and conversation_id=$5 and image_id=$6 and user_message_id=$7 and status='failed' and claim_token is null and job_id is not distinct from $8 returning *`, [claimToken, claimExpiresAt, new Date().toISOString(), owner, input.conversationId, input.imageId, input.userMessageId, input.jobId ?? null]);
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
    await deleteStoredChatImages([record.storagePath]);
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

export async function uploadChatImageObject(
  path: string,
  bytes: Uint8Array,
  contentType: ChatImageContentType,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new ChatImageError("cancelled", "Image upload was cancelled.", 499);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChatImageError("upload_timeout", "Image upload timed out.", 408)), CHAT_IMAGE_UPLOAD_TIMEOUT_MS);
    abortHandler = () => reject(new ChatImageError("cancelled", "Image upload was cancelled.", 499));
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    const result = await Promise.race([
      storage().upload(path, Buffer.from(bytes), {
        contentType,
        upsert: true,
        cacheControl: "3600",
      }),
      deadline,
    ]);
    if (result.error) throw new ChatImageError("upload_failed", "The image could not be uploaded.", 503);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
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
  if (!image.storagePath.startsWith(`${ownerId}/${conversationId}/`)) {
    throw new ChatImageError("unauthorized_image", "That image is not available in this conversation.", 403);
  }
  return downloadChatImageObjectByPath(image.storagePath, image.contentType);
}

export async function downloadChatImageObjectByPath(path: string, contentType: ChatImageContentType): Promise<Uint8Array> {
  const { data, error } = await storage().download(path);
  if (error || !data) throw new ChatImageError("storage_read_failed", "The image could not be read.", 503);
  const bytes = new Uint8Array(await data.arrayBuffer());
  validateChatImageBytes(bytes, contentType);
  return bytes;
}

export async function deleteStoredChatImages(paths: string[]): Promise<void> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return;
  for (let offset = 0; offset < unique.length; offset += STORAGE_PAGE_SIZE) {
    const { error } = await storage().remove(unique.slice(offset, offset + STORAGE_PAGE_SIZE));
    if (error) throw new ChatImageError("cleanup_failed", "Stored images could not be removed.", 503);
  }
}

export async function deleteChatImagesForConversation(ownerId: string, conversationId: string): Promise<void> {
  const root = `${ownerId}/${conversationId}`;
  const paths: string[] = [];
  const visit = async (prefix: string): Promise<void> => {
    let offset = 0;
    while (true) {
      const { data, error } = await storage().list(prefix, {
        limit: STORAGE_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new ChatImageError("cleanup_failed", "Stored images could not be listed.", 503);
      const entries = data ?? [];
      for (const entry of entries) {
        const path = `${prefix}/${entry.name}`;
        if (entry.id) paths.push(path);
        else await visit(path);
      }
      if (entries.length < STORAGE_PAGE_SIZE) break;
      offset += entries.length;
    }
  };
  await visit(root);
  await deleteStoredChatImages(paths);
}
