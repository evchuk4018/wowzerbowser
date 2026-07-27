import "server-only";
import { DOCX_CONTENT_TYPE, estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment, type ChatDocumentPage } from "../../../lib/chat-document";
import { documentStoragePath, registerDocument, uploadDocumentBytes } from "./chat-document-store";
import { parseDocx } from "./docx-parser";
import { analyzeDocumentImage } from "./chat-image-service";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "./document-ingestion-timing";
import { parsePdfNatively } from "./pdf-native-parser";
import { renderPdfPagesSettled } from "./pdf-page-renderer";
import { getPdfOcrConcurrency, ocrPdfPages } from "./pdf-page-ocr";

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
    const processed = await input.timing.measure(DOCUMENT_INGESTION_STAGES.OCR, () => ocrPdfPages({ pages: batch, renderedPages: rendered.renderedPages, renderFailures: rendered.failures, signal: input.signal }));
    for (const page of processed) results.set(page.pageNumber, page);
  }
  return input.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber).map((page) => results.get(page.pageNumber) ?? { pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" });
}

export async function ingestPdf(input: { ownerId: string; conversationId: string; pdfId: string; filename: string; bytes: Uint8Array; downloadUrl?: string; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal; timing?: DocumentIngestionTiming }): Promise<ChatDocumentAttachment> {
  const timing = createTiming({ documentType: "application/pdf", byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
  const ownsTiming = !input.timing;
  try {
    const native = await timing.measure(DOCUMENT_INGESTION_STAGES.NATIVE_PARSING, () => parsePdfNatively(input.bytes, { signal: input.signal }));
    if (!input.alreadyUploaded) await timing.measure(DOCUMENT_INGESTION_STAGES.SUPABASE_UPLOAD, () => uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.pdfId, "application/pdf"), input.bytes, "application/pdf"));
    const ocrInputs = native.pages.map((page, index) => ({
      pageNumber: page.pageNumber,
      nativeText: page.text,
      needsOcr: native.pageOcrDecisions[index]?.needsOcr ?? false,
    }));
    const pagesNeedingOcr = ocrInputs.filter((page) => page.needsOcr).map((page) => page.pageNumber);
    let pages: ChatDocumentPage[];
    if (pagesNeedingOcr.length > 0) {
      pages = await processSelectedPdfPages({ bytes: input.bytes, pages: ocrInputs, signal: input.signal, timing });
      if (pages.some((page) => page.failure)) timing.markFailed(DOCUMENT_INGESTION_STAGES.OCR);
    } else {
      pages = ocrInputs.map((page) => ({ pageNumber: page.pageNumber, text: page.nativeText, extractionMethod: page.nativeText.trim() ? "native" : "blank" }));
    }
    timing.updateMetadata({ pageCount: native.pageCount, ocrPageCount: native.pageOcrDecisions.filter((decision) => decision.needsOcr).length });
    const document: ChatDocumentAttachment = { id: input.pdfId, name: input.filename, contentType: "application/pdf", size: input.bytes.length, pageCount: native.pageCount, tokenEstimate: estimatePdfTokens(pages.map((p) => p.text).join("")), hasImages: native.imageObjectCount > 0, imageCount: native.imageObjectCount, analyzedImageCount: 0, imageAnalyses: [] };
    await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages, timing });
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
    return document;
  } catch (error) {
    markSkippedStages(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
    if (ownsTiming) finishOwnedTiming(timing, [DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, DOCUMENT_INGESTION_STAGES.PAGE_RENDERING, DOCUMENT_INGESTION_STAGES.OCR, DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS]);
    throw error;
  }
}

export async function ingestDocx(input: { ownerId: string; conversationId: string; documentId: string; filename: string; bytes: Uint8Array; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal; timing?: DocumentIngestionTiming }): Promise<ChatDocumentAttachment> {
  const timing = createTiming({ documentType: DOCX_CONTENT_TYPE, byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
  const ownsTiming = !input.timing;
  try {
    const parsed = await timing.measure(DOCUMENT_INGESTION_STAGES.NATIVE_PARSING, () => {
      if (input.bytes.length > MAX_PDF_BYTES) throw new Error("Documents must be 25 MiB or smaller.");
      return parseDocx(input.bytes);
    });
    timing.updateMetadata({ pageCount: parsed.pages.length });
    if (!input.alreadyUploaded) await timing.measure(DOCUMENT_INGESTION_STAGES.SUPABASE_UPLOAD, () => uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.documentId, DOCX_CONTENT_TYPE), input.bytes, DOCX_CONTENT_TYPE));
    const settled = await timing.measure(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS, () => Promise.allSettled(parsed.images.map((image) => analyzeDocumentImage(image.bytes, image.contentType, input.signal).then((analysis) => ({ imageNumber: image.imageNumber, ...analysis })))));
    if (settled.some((result) => result.status === "rejected")) timing.markFailed(DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS);
    const imageAnalyses = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const ocrPageCount = imageAnalyses.filter((analysis) => Boolean(analysis.visibleText?.trim())).length;
    timing.updateMetadata({ ocrPageCount });
    const document: ChatDocumentAttachment = { id: input.documentId, name: input.filename, contentType: DOCX_CONTENT_TYPE, size: input.bytes.length, pageCount: parsed.pages.length, tokenEstimate: estimatePdfTokens(parsed.pages.map((page) => page.text).join("")), hasImages: parsed.imageCount > 0, imageCount: parsed.imageCount, analyzedImageCount: imageAnalyses.length, imageAnalyses };
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
