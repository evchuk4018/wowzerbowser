import "server-only";

import { ChatDocumentError, type ChatDocumentAttachment } from "../../../lib/chat-document";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import { getStorageObjectById } from "../storage/storage-repository";
import { DocumentIngestionTiming } from "./document-ingestion-timing";
import { ingestDocx, ingestPdf } from "./chat-document-service";
import {
  completeDocumentProcessingJob,
  failDocumentProcessingJob,
  heartbeatDocumentProcessingJob,
  type DocumentProcessingJobClaim,
  DOCUMENT_JOB_HEARTBEAT_MS,
  updateDocumentProcessingProgress,
} from "./document-processing-job-store";

export type RunDocumentProcessingJobOptions = {
  shutdownSignal?: AbortSignal;
};

function publicDocumentError(error: unknown): string {
  if (error instanceof ChatDocumentError) return error.message.slice(0, 500);
  return "The document could not be processed by the background worker.";
}

function retryableDocumentError(error: unknown): boolean {
  if (!(error instanceof ChatDocumentError)) return true;
  return !new Set(["document_too_large", "document_storage_invalid", "document_storage_changed", "parser_cancelled"]).has(error.code);
}

export async function runClaimedDocumentProcessingJob(
  ownerId: string,
  claim: DocumentProcessingJobClaim,
  options: RunDocumentProcessingJobOptions = {},
): Promise<ChatDocumentAttachment | null> {
  const controller = new AbortController();
  let progress = claim.progress;
  let timing: DocumentIngestionTiming | null = null;
  const onShutdown = () => controller.abort();
  options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = heartbeatDocumentProcessingJob(ownerId, claim, progress)
      .then((state) => {
        if (state.cancelled) {
          controller.abort();
        } else if (!state.active) {
          controller.abort();
        }
      })
      .catch(() => controller.abort())
      .finally(() => { heartbeatInFlight = null; });
  }, DOCUMENT_JOB_HEARTBEAT_MS);

  const reportProgress = (next: typeof progress): void => {
    progress = next;
    void updateDocumentProcessingProgress(ownerId, claim, progress).catch(() => undefined);
  };

  try {
    const object = await getStorageObjectById({
      ownerId,
      objectId: claim.request.storageObjectId,
      conversationId: claim.conversationId,
      state: "complete",
    });
    if (!object || object.kind !== "document" || object.documentId !== claim.request.documentId || object.contentType !== claim.request.contentType) {
      throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is invalid.", 409);
    }
    const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
    if (bytes.byteLength !== object.size) throw new ChatDocumentError("document_storage_changed", "The document has changed since it was uploaded.", 409);
    timing = new DocumentIngestionTiming({ documentType: claim.request.contentType, byteSize: bytes.byteLength, cacheStatus: "bypass" });
    reportProgress({ stage: "queued", completed: 0, total: 1 });
    const common = {
      ownerId,
      conversationId: claim.conversationId,
      filename: claim.request.filename,
      bytes,
      storageObjectId: claim.request.storageObjectId,
      userMessageId: claim.request.userMessageId ?? undefined,
      jobId: claim.request.sourceJobId ?? undefined,
      alreadyUploaded: true,
      signal: controller.signal,
      timing,
      onProgress: (next: { stage: string; completed?: number; total?: number; pageNumber?: number }) => reportProgress(next),
    };
    const document = claim.request.contentType === "application/pdf"
      ? await ingestPdf({ ...common, pdfId: claim.request.documentId })
      : await ingestDocx({ ...common, documentId: claim.request.documentId });
    if (controller.signal.aborted) return null;
    reportProgress({ stage: "completed", completed: 1, total: 1 });
    const applied = await completeDocumentProcessingJob(ownerId, claim, document, progress);
    return applied ? document : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    await failDocumentProcessingJob(ownerId, claim, publicDocumentError(error), retryableDocumentError(error)).catch(() => undefined);
    return null;
  } finally {
    if (timing) {
      timing.finish();
      timing.log((entry) => console.info(entry));
    }
    clearInterval(heartbeat);
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
