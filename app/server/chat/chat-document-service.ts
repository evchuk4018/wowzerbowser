import "server-only";
import { ChatDocumentError, DOCX_CONTENT_TYPE, estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment, type ChatDocumentPage, type NativePdfExtraction } from "../../../lib/chat-document";
import { assertSignedDocumentDownloadUrl, createSignedDocumentDownloadUrl, documentStoragePath, registerDocument, uploadDocumentBytes } from "./chat-document-store";
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
}): Promise<ChatDocumentPage[]> {
  const results = new Map<number, ChatDocumentPage>();
  for (const page of input.pages) {
    if (!page.needsOcr) results.set(page.pageNumber, { pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" });
  }
  const selected = input.pages.filter((page) => page.needsOcr);
  const batchSize = getPdfOcrConcurrency();
  for (let start = 0; start < selected.length; start += batchSize) {
    const batch = selected.slice(start, start + batchSize);
    const rendered = await input.timing.measure(DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, () => renderPdfPagesSettled(input.bytes, batch.map((page) => page.pageNumber), { signal: input.signal }));
    const processed = await input.timing.measure(DOCUMENT_INGESTION_STAGES.OCR, () => ocrPdfPages({ pages: batch, renderedPages: rendered.renderedPages, renderFailures: rendered.failures, signal: input.signal, ocrPage: async (page, options) => (await import("../../providers/openrouter/openrouter-image-adapter")).askOpenRouterToOcrPdfPage(page.bytes, { ...options, model: input.visionModel }).then((answer) => answer.content) }));
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
  downloadUrl?: string;
  userMessageId?: string;
  jobId?: string;
  alreadyUploaded?: boolean;
  signal?: AbortSignal;
  timing?: DocumentIngestionTiming;
  projectId?: string; revisionId?: string; parentRevisionId?: string | null; origin?: "generated" | "uploaded"; editable?: boolean; sourceCompleteness?: "complete" | "entrypoint-only";
};

export type PdfIngestionDependencies = {
  parsePdfNatively: typeof parsePdfNatively;
  parsePdfWithOpenRouter: typeof parsePdfWithOpenRouter;
  assertSignedDocumentDownloadUrl: typeof assertSignedDocumentDownloadUrl;
  createSignedDocumentDownloadUrl: typeof createSignedDocumentDownloadUrl;
  uploadDocumentBytes: typeof uploadDocumentBytes;
  registerDocument: typeof registerDocument;
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

async function uploadPdfIfNeeded(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming): Promise<void> {
  if (input.alreadyUploaded) return;
  await timing.measure(DOCUMENT_INGESTION_STAGES.SUPABASE_UPLOAD, () => deps.uploadDocumentBytes(
    documentStoragePath(input.ownerId, input.conversationId, input.pdfId, "application/pdf"),
    input.bytes,
    "application/pdf",
  ));
}

async function parsePdfExternally(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming): Promise<ChatDocumentPage[]> {
  const pages = await timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, async () => {
    const signedUrl = input.downloadUrl
      ? deps.assertSignedDocumentDownloadUrl({ ownerId: input.ownerId, conversationId: input.conversationId, documentId: input.pdfId, contentType: "application/pdf", signedUrl: input.downloadUrl })
      : await deps.createSignedDocumentDownloadUrl({ ownerId: input.ownerId, conversationId: input.conversationId, documentId: input.pdfId, contentType: "application/pdf" });
    return deps.parsePdfWithOpenRouter(signedUrl, input.filename, input.signal);
  });
  return pages.map((page, index) => ({
    pageNumber: index + 1,
    text: page.text,
    extractionMethod: page.text.trim() ? "native" : "blank",
  }));
}

async function registerPdf(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming, document: ChatDocumentAttachment, pages: ChatDocumentPage[]): Promise<ChatDocumentAttachment> {
  await deps.registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages, timing });
  return document;
}

export function createPdfIngestor(overrides: Partial<PdfIngestionDependencies> = {}) {
  const deps: PdfIngestionDependencies = {
    parsePdfNatively,
    parsePdfWithOpenRouter,
    assertSignedDocumentDownloadUrl,
    createSignedDocumentDownloadUrl,
    uploadDocumentBytes,
    registerDocument,
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
        await uploadPdfIfNeeded(input, deps, timing);
        const pages = await parsePdfExternally(input, deps, timing);
        timing.updateMetadata({ pageCount: pages.length, ocrPageCount: 0 });
        const document = createPdfDocument(input, pages, { pageCount: pages.length, imageCount: 0 });
        await registerPdf(input, deps, timing, document, pages);
        markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
        if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
        return document;
      }

      await uploadPdfIfNeeded(input, deps, timing);
      const ocrInputs = native.pages.map((page, index) => ({
        pageNumber: page.pageNumber,
        nativeText: page.text,
        needsOcr: native.pageOcrDecisions[index]?.needsOcr ?? false,
      }));
      const pagesNeedingOcr = ocrInputs.filter((page) => page.needsOcr).map((page) => page.pageNumber);
      let pages: ChatDocumentPage[];
      if (pagesNeedingOcr.length > 0) {
        pages = await processSelectedPdfPages({ bytes: input.bytes, pages: ocrInputs, signal: input.signal, timing, visionModel });
        if (pages.some((page) => page.failure)) timing.markFailed(DOCUMENT_INGESTION_STAGES.OCR);
      } else {
        pages = ocrInputs.map((page) => ({ pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" }));
      }
      timing.updateMetadata({ pageCount: native.pageCount, ocrPageCount: native.pageOcrDecisions.filter((decision) => decision.needsOcr).length });
      const document = createPdfDocument(input, pages, { pageCount: native.pageCount, imageCount: native.imageObjectCount });
      await registerPdf(input, deps, timing, document, pages);
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

export async function ingestDocx(input: { ownerId: string; conversationId: string; documentId: string; filename: string; bytes: Uint8Array; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal; timing?: DocumentIngestionTiming; projectId?: string; revisionId?: string; parentRevisionId?: string | null; origin?: "generated" | "uploaded"; editable?: boolean; sourceCompleteness?: "complete" | "entrypoint-only" }): Promise<ChatDocumentAttachment> {
  const timing = createTiming({ documentType: DOCX_CONTENT_TYPE, byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
  const ownsTiming = !input.timing;
  try {
    const visionModel = await configuredVisionModel(input.ownerId).catch(() => null);
    const parsed = await timing.measure(DOCUMENT_INGESTION_STAGES.NATIVE_PARSING, () => {
      if (input.bytes.length > MAX_PDF_BYTES) throw new Error("Documents must be 25 MiB or smaller.");
      return parseDocx(input.bytes);
    });
    timing.updateMetadata({ pageCount: parsed.pages.length });
    if (!input.alreadyUploaded) await timing.measure(DOCUMENT_INGESTION_STAGES.SUPABASE_UPLOAD, () => uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.documentId, DOCX_CONTENT_TYPE), input.bytes, DOCX_CONTENT_TYPE));
    const settled = await timing.measure(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS, () => Promise.allSettled(parsed.images.map((image) => analyzeDocumentImage(image.bytes, image.contentType, input.signal, visionModel).then((analysis) => ({ imageNumber: image.imageNumber, ...analysis })))));
    if (settled.some((result) => result.status === "rejected")) timing.markFailed(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS);
    const imageAnalyses = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const ocrPageCount = imageAnalyses.filter((analysis) => Boolean(analysis.visibleText?.trim())).length;
    timing.updateMetadata({ ocrPageCount });
    const document: ChatDocumentAttachment = { id: input.documentId, name: input.filename, contentType: DOCX_CONTENT_TYPE, size: input.bytes.length, pageCount: parsed.pages.length, tokenEstimate: estimatePdfTokens(parsed.pages.map((page) => page.text).join("")), hasImages: parsed.imageCount > 0, imageCount: parsed.imageCount, analyzedImageCount: imageAnalyses.length, imageAnalyses, ...(input.projectId ? { projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin, editable: input.editable, sourceCompleteness: input.sourceCompleteness } : {}) };
    await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages: parsed.pages, timing });
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    return document;
  } catch (error) {
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR]);
    throw error;
  }
}
