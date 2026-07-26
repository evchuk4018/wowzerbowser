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

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHAT_IMAGE_CLAIM_LEASE_MS = 5 * 60 * 1_000;
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

function recordFromRow(row: Record<string, unknown>): ChatImageUploadRecord {
  return {
    ownerId: String(row.owner_id),
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
    claimExpiresAt: typeof row.claim_expires_at === "string" ? row.claim_expires_at : null,
    updatedAt: String(row.updated_at),
  };
}

export function attachmentFromUploadRecord(record: ChatImageUploadRecord): ChatImageAttachment | null {
  if (record.status !== "complete" || !record.analysis) return null;
  return {
    id: record.imageId,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    storagePath: record.storagePath,
    analysis: record.analysis,
  };
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
  const { error } = await getServerClient().from("chat_conversations").upsert({
    owner_id: ownerId,
    conversation_id: conversationId,
    title: "New conversation",
  }, { onConflict: "owner_id,conversation_id", ignoreDuplicates: true });
  if (error) throw new ChatImageError("storage", "Chat storage is unavailable.", 503);
}

export async function getChatImageUploadRecord(ownerId: string, conversationId: string, imageId: string): Promise<ChatImageUploadRecord | null> {
  assertId(conversationId, "conversationId");
  assertId(imageId, "imageId");
  const { data, error } = await getServerClient()
    .from("chat_image_uploads")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("image_id", imageId)
    .maybeSingle();
  if (error) throw new ChatImageError("storage", "Image upload metadata is unavailable.", 503);
  return data ? recordFromRow(data as Record<string, unknown>) : null;
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
  const db = getServerClient();
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(Date.now() + CHAT_IMAGE_CLAIM_LEASE_MS).toISOString();
  const row = {
    owner_id: input.ownerId,
    conversation_id: input.conversationId,
    image_id: input.imageId,
    user_message_id: input.userMessageId,
    job_id: input.jobId ?? null,
    storage_path: input.storagePath,
    name: input.name,
    content_type: input.contentType,
    size: input.size,
    content_hash: input.contentHash ?? null,
    status: "processing",
    analysis: null,
    error: null,
    claim_token: claimToken,
    claim_expires_at: claimExpiresAt,
  };
  const inserted = await db.from("chat_image_uploads").insert(row).select("*").maybeSingle();
  if (!inserted.error && inserted.data) return { record: recordFromRow(inserted.data as Record<string, unknown>), claimed: true };
  if (inserted.error?.code !== "23505") throw new ChatImageError("storage", "Image upload metadata could not be created.", 503);
  const existing = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
  if (!existing) throw new ChatImageError("storage", "Image upload metadata could not be loaded.", 503);
  if (
    (existing.contentHash && input.contentHash && existing.contentHash !== input.contentHash)
    || (!existing.contentHash && (existing.contentType !== input.contentType || existing.size !== input.size))
  ) {
    throw new ChatImageError("image_id_conflict", "That image ID already belongs to different image data.", 409);
  }
  if (existing.status !== "processing") return { record: existing, claimed: false };
  const claimExpired = !existing.claimExpiresAt || Date.parse(existing.claimExpiresAt) <= Date.now();
  if (!claimExpired) return { record: existing, claimed: false };
  const reclaimed = await db.from("chat_image_uploads")
    .update({
      status: "processing",
      content_hash: input.contentHash ?? existing.contentHash,
      analysis: null,
      error: null,
      claim_token: claimToken,
      claim_expires_at: claimExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", input.ownerId)
    .eq("conversation_id", input.conversationId)
    .eq("image_id", input.imageId)
    .eq("status", "processing")
    .or(`claim_expires_at.is.null,claim_expires_at.lte.${new Date().toISOString()}`)
    .select("*")
    .maybeSingle();
  if (reclaimed.error) throw new ChatImageError("storage", "Image upload metadata could not be claimed.", 503);
  if (!reclaimed.data) {
    const current = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
    if (!current) throw new ChatImageError("storage", "Image upload metadata could not be claimed.", 503);
    return { record: current, claimed: false };
  }
  return { record: recordFromRow(reclaimed.data as Record<string, unknown>), claimed: true };
}

export async function completeChatImageUpload(
  ownerId: string,
  conversationId: string,
  imageId: string,
  claimToken: string,
  analysis: ChatImageAttachment["analysis"],
): Promise<ChatImageUploadRecord> {
  const updated = await getServerClient().from("chat_image_uploads")
    .update({
      status: "complete",
      analysis,
      error: null,
      claim_token: null,
      claim_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("image_id", imageId)
    .eq("status", "processing")
    .eq("claim_token", claimToken)
    .select("*")
    .maybeSingle();
  if (updated.error) throw new ChatImageError("storage", "Image analysis metadata could not be saved.", 503);
  if (updated.data) return recordFromRow(updated.data as Record<string, unknown>);
  const current = await getChatImageUploadRecord(ownerId, conversationId, imageId);
  if (current?.status === "complete") return current;
  throw new ChatImageError("storage", "Image analysis metadata could not be saved.", 503);
}

export async function failChatImageUpload(ownerId: string, conversationId: string, imageId: string, claimToken: string, errorMessage: string): Promise<void> {
  const { error } = await getServerClient().from("chat_image_uploads").update({
    status: "failed",
    analysis: null,
    error: errorMessage.slice(0, 2_000),
    claim_token: null,
    claim_expires_at: null,
    updated_at: new Date().toISOString(),
  })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("image_id", imageId)
    .eq("status", "processing")
    .eq("claim_token", claimToken);
  if (error) throw new ChatImageError("storage", "Image failure metadata could not be saved.", 503);
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
  const { data, error } = await getServerClient()
    .from("chat_messages")
    .select("attachments")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("role", "user");
  if (error) throw new ChatImageError("storage", "Image metadata is unavailable.", 503);
  for (const row of data ?? []) {
    const attachments = Array.isArray((row as { attachments?: unknown }).attachments)
      ? (row as { attachments: unknown[] }).attachments
      : [];
    const value = attachments.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === imageId);
    if (value && typeof value === "object") return value as ChatImageAttachment;
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
