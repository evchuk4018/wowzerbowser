import "server-only";

import { ChatImageError, type ChatImageContentType } from "../../../lib/chat-image";
import { MAX_DOCUMENT_IMAGE_BYTES, type ChatDocumentImage } from "../../../lib/chat-document";
import { getStorageObjectById } from "../storage/storage-repository";
import { deleteOwnedStorageObject, storeStorageObject } from "../storage/storage-service";
import { analyzeDocumentImage } from "./chat-image-service";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

function imageConcurrency(value?: number): number {
  const configured = value ?? runtimeConfigSnapshot().pdfImageAnalysisConcurrency;
  if (!Number.isSafeInteger(configured) || configured < 1) return 2;
  return Math.min(configured, 8);
}

export type DocumentImageCandidate = {
  imageId: string;
  pageNumber: number;
  pageNumbers?: readonly number[];
  source: string;
  bytes: Uint8Array;
};

export type DocumentImageAnalysis = {
  visibleText: string | null;
  mainVisuals: string | null;
};

export type DocumentImageAnalysisFunction = (
  bytes: Uint8Array,
  contentType: ChatImageContentType,
  signal?: AbortSignal,
  visionModel?: string | null,
  usageContext?: { ownerId: string; conversationId: string; jobId?: string; requestId: string },
) => Promise<DocumentImageAnalysis>;

export type PrepareDocumentImagesInput = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  documentId: string;
  filename: string;
  projectId?: string;
  revisionId?: string;
  candidates: readonly DocumentImageCandidate[];
  signal?: AbortSignal;
  visionModel?: string | null;
  concurrency?: number;
  analyze?: DocumentImageAnalysisFunction;
};

type PreparedImage = {
  image: ChatDocumentImage;
  storageObjectId: string | null;
};

function analysisError(error: unknown): string {
  if (error instanceof ChatImageError) return error.message.slice(0, 500);
  return "Image visual analysis was unavailable.";
}

function imageMetadata(input: {
  candidate: DocumentImageCandidate;
  analysis?: DocumentImageAnalysis;
  error?: unknown;
}) {
  return {
    source: input.candidate.source,
    ...(input.analysis
      ? { analysisStatus: "complete", analysis: input.analysis }
      : { analysisStatus: "failed", analysisError: analysisError(input.error) }),
  };
}

async function prepareOne(input: PrepareDocumentImagesInput, candidate: DocumentImageCandidate): Promise<PreparedImage> {
  if (candidate.bytes.byteLength > MAX_DOCUMENT_IMAGE_BYTES) {
    return {
      storageObjectId: null,
      image: {
        imageId: candidate.imageId,
        pageNumber: candidate.pageNumber,
        providerMetadata: imageMetadata({ candidate, error: new Error("The extracted image is too large.") }),
      },
    };
  }

  let analysis: DocumentImageAnalysis | undefined;
  let error: unknown;
  try {
    analysis = await (input.analyze ?? analyzeDocumentImage)(candidate.bytes, "image/png", input.signal, input.visionModel, {
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      jobId: input.jobId,
      requestId: `${input.documentId}:${candidate.imageId}:analysis`,
    });
  } catch (reason) {
    error = reason;
  }

  const object = await storeStorageObject({
    metadata: {
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      documentId: input.documentId,
      projectId: input.projectId,
      revisionId: input.revisionId,
      kind: "document-image",
      originalFilename: `${input.filename}-${candidate.imageId}.png`,
      contentType: "image/png",
    },
    source: candidate.bytes,
    maxBytes: MAX_DOCUMENT_IMAGE_BYTES,
    signal: input.signal,
  });

  return {
    storageObjectId: object.objectId,
    image: {
      imageId: candidate.imageId,
      pageNumber: candidate.pageNumber,
      storageObjectId: object.objectId,
      storagePath: object.objectKey,
      contentType: "image/png",
      providerMetadata: imageMetadata({ candidate, analysis, error }),
    },
  };
}

export async function prepareDocumentImages(input: PrepareDocumentImagesInput): Promise<ChatDocumentImage[]> {
  const candidates = [...input.candidates];
  if (!candidates.length) return [];
  const concurrency = Math.min(imageConcurrency(input.concurrency), candidates.length);
  const results: Array<PreparedImage | undefined> = [];
  const storedObjectIds: string[] = [];
  let next = 0;

  const worker = async () => {
    while (true) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Document image preparation was cancelled.");
      const index = next++;
      if (index >= candidates.length) return;
      const prepared = await prepareOne(input, candidates[index]);
      results[index] = prepared;
      if (prepared.storageObjectId) storedObjectIds.push(prepared.storageObjectId);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results.map((result) => result!.image);
  } catch (error) {
    await Promise.all(storedObjectIds.map((objectId) => deleteOwnedStorageObject({ ownerId: input.ownerId, objectId }).catch(() => undefined)));
    throw error;
  }
}

export async function deleteDocumentImages(ownerId: string, images: readonly ChatDocumentImage[]): Promise<void> {
  await Promise.all(images.flatMap((image) => image.storageObjectId
    ? [deleteOwnedStorageObject({ ownerId, objectId: image.storageObjectId }).catch(() => undefined)]
    : []));
}

export async function readDocumentImageBytes(input: { ownerId: string; conversationId: string; image: ChatDocumentImage }): Promise<Uint8Array | null> {
  if (!input.image.storageObjectId) return null;
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.image.storageObjectId, conversationId: input.conversationId, state: "complete" });
  if (!object || object.kind !== "document-image" || object.documentId === null || object.objectKey !== input.image.storagePath || object.contentType !== input.image.contentType) return null;
  const bytes = await import("../storage/local-filesystem-storage").then(({ localFilesystemStorageProvider }) => localFilesystemStorageProvider.readObjectBytes(object));
  return bytes.byteLength === object.size ? bytes : null;
}
