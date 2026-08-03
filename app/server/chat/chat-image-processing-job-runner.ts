import "server-only";

import { ChatImageError, validateChatImageBytes, type ChatImageAttachment } from "../../../lib/chat-image";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import { getStorageObjectById } from "../storage/storage-repository";
import { analyzeStoredChatImage } from "./chat-image-service";
import {
  completeQueuedChatImageUpload,
  failQueuedChatImageUpload,
  getChatImageUploadRecord,
  type ChatImageUploadRecord,
} from "./chat-image-store";
import {
  completeChatImageProcessingJob,
  failChatImageProcessingJob,
  heartbeatChatImageProcessingJob,
  type ChatImageProcessingJobClaim,
  IMAGE_PROCESSING_JOB_HEARTBEAT_MS,
} from "./chat-image-processing-job-store";

export type RunChatImageProcessingJobOptions = { shutdownSignal?: AbortSignal };

function publicImageError(error: unknown): string {
  if (error instanceof ChatImageError) return error.message.slice(0, 500);
  return "The image could not be prepared by the background worker.";
}

function retryableImageError(error: unknown): boolean {
  if (!(error instanceof ChatImageError)) return true;
  return !new Set([
    "cancelled",
    "image_storage_invalid",
    "image_storage_changed",
    "malformed_image",
    "spoofed_image_type",
    "image_too_large",
  ]).has(error.code);
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Image worker shutdown requested."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitForStoredImage(input: {
  ownerId: string;
  conversationId: string;
  storageObjectId: string;
  signal: AbortSignal;
}): Promise<NonNullable<Awaited<ReturnType<typeof getStorageObjectById>>>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (input.signal.aborted) throw new ChatImageError("cancelled", "Image analysis was cancelled.", 499);
    const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId });
    if (!object) throw new ChatImageError("image_storage_invalid", "The image storage object was not found.", 409);
    if (object.state === "complete") return object;
    if (object.state === "failed") throw new ChatImageError("image_storage_invalid", "The image storage object failed.", 409);
    await waitFor(500, input.signal);
  }
  throw new ChatImageError("image_storage_changed", "The image upload did not complete.", 409);
}

function attachmentFromRecord(record: ChatImageUploadRecord): ChatImageAttachment | null {
  if (record.status !== "complete" || !record.analysis || record.analysis.status !== "complete") return null;
  return {
    id: record.imageId,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    storagePath: record.storagePath,
    analysis: record.analysis,
  };
}

export async function runClaimedChatImageProcessingJob(
  ownerId: string,
  claim: ChatImageProcessingJobClaim,
  options: RunChatImageProcessingJobOptions = {},
): Promise<ChatImageAttachment | null> {
  const controller = new AbortController();
  const onShutdown = () => controller.abort();
  options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  let heartbeatInFlight: Promise<void> | null = null;
  let progress: { stage?: string } = { stage: "queued" };
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = heartbeatChatImageProcessingJob(ownerId, claim, progress)
      .then((state) => {
        if (state.cancelled || !state.active) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => { heartbeatInFlight = null; });
  }, IMAGE_PROCESSING_JOB_HEARTBEAT_MS);
  const reportProgress = (stage: string) => {
    progress = { stage };
    void heartbeatChatImageProcessingJob(ownerId, claim, progress)
      .then((state) => { if (state.cancelled || !state.active) controller.abort(); })
      .catch(() => controller.abort());
  };

  try {
    const existing = await getChatImageUploadRecord(ownerId, claim.conversationId, claim.imageId);
    if (!existing) throw new ChatImageError("image_storage_invalid", "The image upload metadata was not found.", 409);
    const alreadyComplete = attachmentFromRecord(existing);
    if (alreadyComplete) {
      const applied = await completeChatImageProcessingJob(ownerId, claim, alreadyComplete, { stage: "completed" });
      return applied ? alreadyComplete : null;
    }
    if (existing.status === "failed") throw new ChatImageError("image_storage_invalid", existing.error || "The image upload failed.", 409);

    reportProgress("waiting-for-upload");
    const object = await waitForStoredImage({
      ownerId,
      conversationId: claim.conversationId,
      storageObjectId: claim.request.storageObjectId,
      signal: controller.signal,
    });
    if (object.kind !== "image" || object.objectId !== claim.request.storageObjectId || object.contentType !== claim.request.contentType || object.messageId !== claim.request.userMessageId) {
      throw new ChatImageError("image_storage_invalid", "The image storage object is invalid.", 409);
    }
    const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
    if (bytes.byteLength !== object.size) throw new ChatImageError("image_storage_changed", "The image changed after upload.", 409);
    validateChatImageBytes(bytes, claim.request.contentType);
    reportProgress("analyzing");
    const analysis = await analyzeStoredChatImage({
      ownerId,
      conversationId: claim.conversationId,
      userMessageId: claim.request.userMessageId,
      imageId: claim.imageId,
      jobId: claim.request.chatJobId ?? claim.jobId,
      bytes,
      contentType: claim.request.contentType,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return null;
    const completedRecord = await completeQueuedChatImageUpload(ownerId, claim.conversationId, claim.imageId, analysis);
    const attachment = attachmentFromRecord(completedRecord);
    if (!attachment) throw new ChatImageError("storage", "Image analysis metadata is incomplete.", 503);
    const applied = await completeChatImageProcessingJob(ownerId, claim, attachment, { stage: "completed" });
    return applied ? attachment : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    const message = publicImageError(error);
    await failChatImageProcessingJob(ownerId, claim, message, retryableImageError(error)).catch(() => undefined);
    if (!retryableImageError(error)) await failQueuedChatImageUpload(ownerId, claim.conversationId, claim.imageId, message).catch(() => undefined);
    return null;
  } finally {
    clearInterval(heartbeat);
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
