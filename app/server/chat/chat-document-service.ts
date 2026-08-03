import "server-only";
import { ChatDocumentError, DOCX_CONTENT_TYPE, estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment, type ChatDocumentPage, type NativePdfExtraction } from "../../../lib/chat-document";
import { getStorageObjectById } from "../storage/storage-repository";
import type { StorageObject } from "../../../lib/storage-protocol";
import { registerDocument, uploadDocumentBytes } from "./chat-document-store";
import { parsePdfWithOpenRouter } from "../../providers/openrouter/openrouter-document-adapter";
import { parseDocx } from "./docx-parser";
import { analyzeDocumentImage } from "./chat-image-service";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "./document-ingestion-timing";
import { parsePdfNatively } from "./pdf-native-parser";
import { renderPdfPagesSettled } from "./pdf-page-renderer";
import { getPdfOcrConcurrency, ocrPdfPages } from "./pdf-page-ocr";
import { configuredVisionModel } from "./chat-model-catalog-service";

function finishOwnedTiming(timing: DocumentIngestionTiming, skipped: readonly DocumentIngestionStage[]) {
  markSkippedStages(timing, skipped);
  timing.finish();
  timing.log((entry) => console.info(entry));
}

function markSkippedStages(timing: DocumentIngestionTiming, skipped: readonly DocumentIngestionStage[]) {
  for (const stage of skipped) if (timing.snapshot().stageDurations[stage] === undefined) timing.recordStage(stage, 0);
}

function createTiming(input: { documentType: string; byteSize: number; alreadyUploaded?: boolean; timing?: DocumentIngestionTiming }) {
  return input.timing ?? new DocumentIngestionTiming({ documentType: input.documentType, byteSize: input.byteSize, cacheStatus: input.alreadyUploaded ? "bypass" : "unknown" });
}

async function processSelectedPdfPages(input: {
  bytes: Uint8Array;
  pages: Array<{ pageNumber: number; nativeText: string; needsOcr: boolean }>;
  signal?: AbortSignal;
  timing: DocumentIngestionTiming;
  visionModel?: string | null;
  onProgress?: (progress: { stage: string; completed: number; total: number; pageNumber?: number }) => void;
}): Promise<ChatDocumentPage[]> {
  const results = new Map<number, ChatDocumentPage>();
  for (const page of input.pages) {
    if (!page.needsOcr) results.set(page.pageNumber, { pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" });
  }
  const selected = input.pages.filter((page) => page.needsOcr);
  const batchSize = getPdfOcrConcurrency();
  let completed = 0;
  for (let start = 0; start < selected.length; start += batchSize) {
    const batch = selected.slice(start, start + batchSize);
    input.onProgress?.({ stage: DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, completed, total: selected.length });
    const rendered = await input.timing.measure(DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, () => renderPdfPagesSettled(input.bytes, batch.map((page) => page.pageNumber), { signal: input.signal }));
    const processed = await input.timing.measure(DOCUMENT_INGESTION_STAGES.OCR, () => ocrPdfPages({
      pages: batch,
      renderedPages: rendered.renderedPages,
      renderFailures: rendered.failures,
      signal: input.signal,
      onProgress: ({ completed: batchCompleted, total, page }) => input.onProgress?.({ stage: DOCUMENT_INGESTION_STAGES.OCR, completed: completed + batchCompleted, total: selected.length || total, pageNumber: page.pageNumber }),
      ocrPage: async (page, options) => (await import("../../providers/openrouter/openrouter-image-adapter")).askOpenRouterToOcrPdfPage(page.bytes, { ...options, model: input.visionModel }).then((answer) => answer.content),
    }));
    completed += batch.length;
    for (const page of processed) results.set(page.pageNumber, page);
  }
  return input.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber).map((page) => results.get(page.pageNumber) ?? { pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" });
}

export type PdfIngestionInput = {
  ownerId: string;
  conversationId: string;
  pdfId: string;
  filename: string;
  bytes: Uint8Array;
  storageObjectId?: string;
  userMessageId?: string;
  jobId?: string;
  alreadyUploaded?: boolean;
  signal?: AbortSignal;
  timing?: DocumentIngestionTiming;
  onProgress?: (progress: { stage: string; completed?: number; total?: number; pageNumber?: number }) => void;
  projectId?: string; revisionId?: string; parentRevisionId?: string | null; origin?: "generated" | "uploaded"; editable?: boolean; sourceCompleteness?: "complete" | "entrypoint-only";
};

export type PdfIngestionDependencies = {
  parsePdfNatively: typeof parsePdfNatively;
  parsePdfWithOpenRouter: typeof parsePdfWithOpenRouter;
  uploadDocumentBytes: typeof uploadDocumentBytes;
  registerDocument: typeof registerDocument;
  getStorageObjectById: typeof getStorageObjectById;
};

const PDF_SKIPPED_STAGES = [
  DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING,
  DOCUMENT_INGESTION_STAGES.PAGE_RENDERING,
  DOCUMENT_INGESTION_STAGES.OCR,
  DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS,
] as const satisfies readonly DocumentIngestionStage[];

function recoverableNativePdfFailure(error: unknown): boolean {
  return error instanceof ChatDocumentError && error.code === "pdf_parser_failed";
}

function createPdfDocument(input: PdfIngestionInput, pages: ChatDocumentPage[], metadata: { pageCount: number; imageCount: number }): ChatDocumentAttachment {
  return {
    id: input.pdfId,
    name: input.filename,
    contentType: "application/pdf",
    size: input.bytes.length,
    pageCount: metadata.pageCount,
    tokenEstimate: estimatePdfTokens(pages.map((page) => page.text).join("")),
    hasImages: metadata.imageCount > 0,
    imageCount: metadata.imageCount,
    analyzedImageCount: 0,
    imageAnalyses: [],
    ...(input.projectId ? { projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin, editable: input.editable, sourceCompleteness: input.sourceCompleteness } : {}),
  };
}

async function storedPdfObject(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming): Promise<StorageObject> {
  if (input.alreadyUploaded) {
    if (!input.storageObjectId) throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is missing.", 409);
    const object = await deps.getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId, state: "complete" });
    if (!object || object.kind !== "document" || (object.documentId !== null && object.documentId !== input.pdfId) || object.contentType !== "application/pdf" || object.size !== input.bytes.byteLength) throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is invalid.", 409);
    return object;
  }
  return timing.measure(DOCUMENT_INGESTION_STAGES.STORAGE_UPLOAD, () => deps.uploadDocumentBytes({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    documentId: input.pdfId,
    filename: input.filename,
    bytes: input.bytes,
    contentType: "application/pdf",
    projectId: input.projectId,
    revisionId: input.revisionId,
  }));
}

async function parsePdfExternally(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming): Promise<ChatDocumentPage[]> {
  const pages = await timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, () => deps.parsePdfWithOpenRouter(input.bytes, input.filename, input.signal));
  return pages.map((page, index) => ({
    pageNumber: index + 1,
    text: page.text,
    extractionMethod: page.text.trim() ? "native" : "blank",
  }));
}

async function registerPdf(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming, document: ChatDocumentAttachment, pages: ChatDocumentPage[], object: StorageObject): Promise<ChatDocumentAttachment> {
  await deps.registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages, storageObjectId: object.objectId, timing });
  return document;
}

export function createPdfIngestor(overrides: Partial<PdfIngestionDependencies> = {}) {
  const deps: PdfIngestionDependencies = {
    parsePdfNatively,
    parsePdfWithOpenRouter,
    uploadDocumentBytes,
    registerDocument,
    getStorageObjectById,
    ...overrides,
  };

  return async function ingestPdf(input: PdfIngestionInput): Promise<ChatDocumentAttachment> {
    const timing = createTiming({ documentType: "application/pdf", byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
    const ownsTiming = !input.timing;
    try {
      const visionModel = await configuredVisionModel(input.ownerId).catch(() => null);
      let native: NativePdfExtraction;
      try {
        native = await timing.measure(DOCUMENT_INGESTION_STAGES.NATIVE_PARSING, () => deps.parsePdfNatively(input.bytes, { signal: input.signal }));
      } catch (error) {
        if (!recoverableNativePdfFailure(error)) throw error;
        timing.updateMetadata({ fallbackUsed: true });
        const object = await storedPdfObject(input, deps, timing);
        const pages = await parsePdfExternally(input, deps, timing);
        timing.updateMetadata({ pageCount: pages.length, ocrPageCount: 0 });
        const document = createPdfDocument(input, pages, { pageCount: pages.length, imageCount: 0 });
        await registerPdf(input, deps, timing, document, pages, object);
        markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
        if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
        return document;
      }

      const object = await storedPdfObject(input, deps, timing);
      const ocrInputs = native.pages.map((page, index) => ({
        pageNumber: page.pageNumber,
        nativeText: page.text,
        needsOcr: native.pageOcrDecisions[index]?.needsOcr ?? false,
      }));
      const pagesNeedingOcr = ocrInputs.filter((page) => page.needsOcr).map((page) => page.pageNumber);
      let pages: ChatDocumentPage[];
      if (pagesNeedingOcr.length > 0) {
        pages = await processSelectedPdfPages({ bytes: input.bytes, pages: ocrInputs, signal: input.signal, timing, visionModel, onProgress: input.onProgress });
        if (pages.some((page) => page.failure)) timing.markFailed(DOCUMENT_INGESTION_STAGES.OCR);
      } else {
        pages = ocrInputs.map((page) => ({ pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" }));
      }
      timing.updateMetadata({ pageCount: native.pageCount, ocrPageCount: native.pageOcrDecisions.filter((decision) => decision.needsOcr).length });
      const document = createPdfDocument(input, pages, { pageCount: native.pageCount, imageCount: native.imageObjectCount });
      await registerPdf(input, deps, timing, document, pages, object);
      markSkippedStages(timing, PDF_SKIPPED_STAGES);
      if (ownsTiming) finishOwnedTiming(timing, PDF_SKIPPED_STAGES);
      return document;
    } catch (error) {
      markSkippedStages(timing, PDF_SKIPPED_STAGES);
      if (ownsTiming) finishOwnedTiming(timing, PDF_SKIPPED_STAGES);
      throw error;
    }
  };
}

export const ingestPdf = createPdfIngestor();

async function analyzeDocxImagesBounded(
  images: Awaited<ReturnType<typeof parseDocx>>["images"],
  concurrency: number,
  analyze: (image: (typeof images)[number]) => Promise<{ imageNumber: number; visibleText: string | null; mainVisuals: string | null }>,
  onProgress?: (progress: { stage: string; completed: number; total: number; pageNumber?: number }) => void,
): Promise<PromiseSettledResult<{ imageNumber: number; visibleText: string | null; mainVisuals: string | null }>[]> {
  const results: PromiseSettledResult<{ imageNumber: number; visibleText: string | null; mainVisuals: string | null }>[] = [];
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= images.length) return;
      try {
        results[index] = { status: "fulfilled", value: await analyze(images[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        completed += 1;
        onProgress?.({ stage: DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS, completed, total: images.length, pageNumber: images[index].imageNumber });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, images.length)) }, () => worker()));
  return results;
}

export async function ingestDocx(input: { ownerId: string; conversationId: string; documentId: string; filename: string; bytes: Uint8Array; storageObjectId?: string; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal; timing?: DocumentIngestionTiming; onProgress?: (progress: { stage: string; completed?: number; total?: number; pageNumber?: number }) => void; projectId?: string; revisionId?: string; parentRevisionId?: string | null; origin?: "generated" | "uploaded"; editable?: boolean; sourceCompleteness?: "complete" | "entrypoint-only" }): Promise<ChatDocumentAttachment> {
  const timing = createTiming({ documentType: DOCX_CONTENT_TYPE, byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
  const ownsTiming = !input.timing;
  try {
    const visionModel = await configuredVisionModel(input.ownerId).catch(() => null);
    const parsed = await timing.measure(DOCUMENT_INGESTION_STAGES.NATIVE_PARSING, () => {
      if (input.bytes.length > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "Documents must be 25 MiB or smaller.", 413);
      return parseDocx(input.bytes);
    });
    timing.updateMetadata({ pageCount: parsed.pages.length });
    const object = input.alreadyUploaded
      ? (input.storageObjectId ? await getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId, state: "complete" }) : null)
      : await timing.measure(DOCUMENT_INGESTION_STAGES.STORAGE_UPLOAD, () => uploadDocumentBytes({ ownerId: input.ownerId, conversationId: input.conversationId, documentId: input.documentId, filename: input.filename, bytes: input.bytes, contentType: DOCX_CONTENT_TYPE, projectId: input.projectId, revisionId: input.revisionId }));
    if (!object || object.kind !== "document" || (object.documentId !== null && object.documentId !== input.documentId) || object.contentType !== DOCX_CONTENT_TYPE || object.size !== input.bytes.byteLength) throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is invalid.", 409);
    const settled = await timing.measure(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS, () => analyzeDocxImagesBounded(
      parsed.images,
      getPdfOcrConcurrency(),
      (image) => analyzeDocumentImage(image.bytes, image.contentType, input.signal, visionModel).then((analysis) => ({ imageNumber: image.imageNumber, ...analysis })),
      input.onProgress,
    ));
    if (settled.some((result) => result.status === "rejected")) timing.markFailed(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS);
    const imageAnalyses = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const ocrPageCount = imageAnalyses.filter((analysis) => Boolean(analysis.visibleText?.trim())).length;
    timing.updateMetadata({ ocrPageCount });
    const document: ChatDocumentAttachment = { id: input.documentId, name: input.filename, contentType: DOCX_CONTENT_TYPE, size: input.bytes.length, pageCount: parsed.pages.length, tokenEstimate: estimatePdfTokens(parsed.pages.map((page) => page.text).join("")), hasImages: parsed.imageCount > 0, imageCount: parsed.imageCount, analyzedImageCount: imageAnalyses.length, imageAnalyses, ...(input.projectId ? { projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin, editable: input.editable, sourceCompleteness: input.sourceCompleteness } : {}) };
    await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages: parsed.pages, storageObjectId: object.objectId, timing });
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    return document;
  } catch (error) {
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    throw error;
  }
}
