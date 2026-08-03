import "server-only";

import { createHash } from "node:crypto";
import {
  MAX_CHAT_IMAGES_PER_TURN,
  type ChatImageAttachment,
  type ChatImageContentType,
  ChatImageError,
  sanitizeChatImageName,
  validateChatImageBytes,
} from "../../../lib/chat-image";
import { createStorageObject, getStorageObjectById } from "../storage/storage-repository";
import { deleteOwnedStorageObject } from "../storage/storage-service";
import {
  attachmentFromUploadRecord,
  claimChatImageUpload,
  ensureChatImageConversation,
  failChatImageUpload,
  getChatImageUploadRecord,
  releaseChatImageUploadClaim,
  uploadChatImageObject,
} from "./chat-image-store";
import {
  cancelChatImageProcessingJob,
  enqueueChatImageProcessingJob,
  getChatImageProcessingJobForImage,
  type ChatImageProcessingJob,
} from "./chat-image-processing-job-store";

export type ChatImageUpload = {
  id: string;
  name: string | null;
  declaredType: string | null;
  bytes: Uint8Array;
};

export type QueuedChatImage = {
  imageId: string;
  processingJobId: string | null;
  status: ChatImageProcessingJob["status"] | "completed";
  error: string | null;
  attachment: ChatImageAttachment | null;
};

function hashImageBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jobItem(job: ChatImageProcessingJob): QueuedChatImage {
  return {
    imageId: job.imageId,
    processingJobId: job.jobId,
    status: job.status,
    error: job.error,
    attachment: job.attachment,
  };
}

function completedItem(imageId: string, attachment: ChatImageAttachment): QueuedChatImage {
  return { imageId, processingJobId: null, status: "completed", error: null, attachment };
}

function imageQueueError(error: unknown): ChatImageError {
  if (error instanceof ChatImageError) return error;
  return new ChatImageError("storage", "The image could not be queued for background preparation.", 503);
}

async function enqueueExistingImage(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  chatJobId: string;
  imageId: string;
  signal?: AbortSignal;
}): Promise<QueuedChatImage> {
  const record = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.imageId);
  if (!record) throw new ChatImageError("storage", "The image upload metadata could not be loaded.", 503);
  const attachment = attachmentFromUploadRecord(record);
  if (attachment) return completedItem(input.imageId, attachment);
  const existingJob = await getChatImageProcessingJobForImage(input.ownerId, input.conversationId, input.imageId);
  if (existingJob) return jobItem(existingJob);
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: record.storageObjectId, conversationId: input.conversationId, state: "complete" });
  if (!object) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new ChatImageError("analysis_in_progress", "The image is still being uploaded. Please retry shortly.", 409);
  }
  return jobItem(await enqueueChatImageProcessingJob({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    imageId: input.imageId,
    userMessageId: record.userMessageId,
    chatJobId: record.jobId ?? input.chatJobId,
    storageObjectId: record.storageObjectId,
    name: record.name,
    contentType: record.contentType,
  }));
}

async function queueOneChatImage(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  chatJobId: string;
  upload: ChatImageUpload;
  contentType: ChatImageContentType;
  contentHash: string;
  signal?: AbortSignal;
}): Promise<QueuedChatImage> {
  const existing = await getChatImageUploadRecord(input.ownerId, input.conversationId, input.upload.id);
  const existingAttachment = existing && attachmentFromUploadRecord(existing);
  if (existingAttachment) return completedItem(input.upload.id, existingAttachment);
  if (existing?.status === "processing") return enqueueExistingImage({ ...input, imageId: input.upload.id });

  const provisional = await createStorageObject({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    messageId: input.userMessageId,
    kind: "image",
    originalFilename: sanitizeChatImageName(input.upload.name),
    contentType: input.contentType,
  });
  const previousObjectId = existing?.storageObjectId ?? null;
  let claim: Awaited<ReturnType<typeof claimChatImageUpload>> | null = null;
  let processingJob: ChatImageProcessingJob | null = null;
  try {
    claim = await claimChatImageUpload({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      imageId: input.upload.id,
      userMessageId: input.userMessageId,
      jobId: input.chatJobId,
      storagePath: provisional.objectKey,
      storageObjectId: provisional.objectId,
      name: sanitizeChatImageName(input.upload.name),
      contentType: input.contentType,
      size: input.upload.bytes.byteLength,
      contentHash: input.contentHash,
    });
    if (!claim.claimed) {
      await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId: provisional.objectId }).catch(() => undefined);
      return enqueueExistingImage({ ...input, imageId: input.upload.id });
    }
    processingJob = await enqueueChatImageProcessingJob({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      imageId: input.upload.id,
      userMessageId: input.userMessageId,
      chatJobId: input.chatJobId,
      storageObjectId: provisional.objectId,
      name: sanitizeChatImageName(input.upload.name),
      contentType: input.contentType,
    });
    await uploadChatImageObject({ ownerId: input.ownerId, objectId: provisional.objectId, bytes: input.upload.bytes, signal: input.signal });
    await releaseChatImageUploadClaim(input.ownerId, input.conversationId, input.upload.id, claim.record.claimToken!);
    if (previousObjectId && previousObjectId !== provisional.objectId) await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId: previousObjectId }).catch(() => undefined);
    return jobItem(processingJob);
  } catch (error) {
    const failure = imageQueueError(error);
    if (claim?.claimed && claim.record.claimToken) await failChatImageUpload(input.ownerId, input.conversationId, input.upload.id, claim.record.claimToken, failure.message).catch(() => undefined);
    if (processingJob) await cancelChatImageProcessingJob(input.ownerId, input.conversationId, processingJob.jobId).catch(() => undefined);
    await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId: provisional.objectId }).catch(() => undefined);
    throw failure;
  }
}

/** Store bounded image bytes and enqueue provider analysis for the worker. */
export async function queueChatImageProcessing(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  chatJobId: string;
  uploads: ChatImageUpload[];
  signal?: AbortSignal;
}): Promise<QueuedChatImage[]> {
  if (input.uploads.length < 1 || input.uploads.length > MAX_CHAT_IMAGES_PER_TURN) {
    throw new ChatImageError("image_count", `Attach between 1 and ${MAX_CHAT_IMAGES_PER_TURN} images.`);
  }
  if (!input.chatJobId) throw new ChatImageError("invalid_request", "Image uploads must be bound to a chat job.");
  const ids = new Set<string>();
  const prepared = input.uploads.map((upload) => {
    if (ids.has(upload.id)) throw new ChatImageError("duplicate_image_id", "Each image ID may only appear once per turn.");
    ids.add(upload.id);
    const contentType = validateChatImageBytes(upload.bytes, upload.declaredType ?? undefined);
    return { upload, contentType, contentHash: hashImageBytes(upload.bytes) };
  });
  await ensureChatImageConversation(input.ownerId, input.conversationId);
  const queued: QueuedChatImage[] = [];
  for (const item of prepared) {
    queued.push(await queueOneChatImage({
      ...input,
      upload: item.upload,
      contentType: item.contentType,
      contentHash: item.contentHash,
    }));
  }
  return queued;
}
