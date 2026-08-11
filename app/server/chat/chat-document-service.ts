import "server-only";
import { ChatDocumentError, DOCX_CONTENT_TYPE, documentPageMarkdown, estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment, type ChatDocumentImage, type ChatDocumentPage, type ChatDocumentProviderMetadata } from "../../../lib/chat-document";
import { getStorageObjectById } from "../storage/storage-repository";
import type { StorageObject } from "../../../lib/storage-protocol";
import { registerDocument, uploadDocumentBytes } from "./chat-document-store";
import { convertPdfWithOpenDataLoader, type OpenDataLoaderElement, type OpenDataLoaderPdfOutput } from "../../providers/opendataloader/opendataloader-pdf-adapter";
import { parseDocx } from "./docx-parser";
import { analyzeDocumentImage } from "./chat-image-service";
import { prepareDocumentImages, deleteDocumentImages, type DocumentImageCandidate } from "./document-image-service";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "./document-ingestion-timing";
import { configuredVisionModel } from "./chat-model-catalog-service";
import { getPdfOcrConcurrency } from "./pdf-page-ocr";
import { diagnosePdfMathExtraction } from "./pdf-math-diagnostics";

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
  convertPdfWithOpenDataLoader: typeof convertPdfWithOpenDataLoader;
  prepareDocumentImages: typeof prepareDocumentImages;
  uploadDocumentBytes: typeof uploadDocumentBytes;
  registerDocument: typeof registerDocument;
  getStorageObjectById: typeof getStorageObjectById;
};

const PDF_SKIPPED_STAGES = [
  DOCUMENT_INGESTION_STAGES.NATIVE_PARSING,
  DOCUMENT_INGESTION_STAGES.PAGE_RENDERING,
  DOCUMENT_INGESTION_STAGES.OCR,
  DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS,
] as const satisfies readonly DocumentIngestionStage[];

function elementChildren(element: OpenDataLoaderElement): OpenDataLoaderElement[] {
  const children: OpenDataLoaderElement[] = [];
  if (Array.isArray(element.kids)) children.push(...element.kids.filter((child): child is OpenDataLoaderElement => Boolean(child && typeof child === "object")));
  if (Array.isArray(element["list items"])) children.push(...element["list items"].filter((child): child is OpenDataLoaderElement => Boolean(child && typeof child === "object")));
  if (Array.isArray(element.rows)) {
    for (const row of element.rows) {
      if (!row || typeof row !== "object" || !Array.isArray(row.cells)) continue;
      children.push(...(row.cells as unknown[]).filter((child): child is OpenDataLoaderElement => Boolean(child && typeof child === "object")));
    }
  }
  return children;
}

function collectPageElements(element: OpenDataLoaderElement, pages: Map<number, OpenDataLoaderElement[]>): void {
  const page = element["page number"];
  const current = pages.get(page) ?? [];
  current.push(element);
  pages.set(page, current);
  for (const child of elementChildren(element)) collectPageElements(child, pages);
}

function collectElementText(element: OpenDataLoaderElement, parts: string[]): void {
  if (element.type !== "image" && typeof element.content === "string" && element.content.trim()) parts.push(element.content.trim());
  for (const child of elementChildren(element)) collectElementText(child, parts);
}

function pageText(elements: readonly OpenDataLoaderElement[]): string {
  const parts: string[] = [];
  for (const element of elements) collectElementText(element, parts);
  return parts.join("\n\n").trim();
}

function pageProviderMetadata(elements: readonly OpenDataLoaderElement[], mathDiagnostics: ReturnType<typeof diagnosePdfMathExtraction>): ChatDocumentProviderMetadata {
  return {
    provider: "opendataloader",
    mathDiagnostics,
    elements: elements.map((element) => ({
      type: element.type,
      id: element.id,
      pageNumber: element["page number"],
      boundingBox: element["bounding box"],
      ...(typeof element["heading level"] === "number" ? { headingLevel: element["heading level"] } : {}),
      ...(typeof element.source === "string" ? { source: element.source } : {}),
    })),
  };
}

function splitMarkdownByPage(markdown: string, pageCount: number): string[] {
  const pages = Array.from({ length: pageCount }, () => "");
  const marker = /<!--\s*WOWZERBOWSER_ODL_PAGE_(\d+)\s*-->/g;
  let currentPage = 1;
  let cursor = 0;
  for (const match of markdown.matchAll(marker)) {
    const index = match.index ?? cursor;
    if (currentPage >= 1 && currentPage <= pageCount) pages[currentPage - 1] += markdown.slice(cursor, index);
    const nextPage = Number(match[1]);
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && nextPage <= pageCount) currentPage = nextPage;
    cursor = index + match[0].length;
  }
  if (currentPage >= 1 && currentPage <= pageCount) pages[currentPage - 1] += markdown.slice(cursor);
  return pages.map((page) => page.trim());
}

function imageCandidates(output: OpenDataLoaderPdfOutput): DocumentImageCandidate[] {
  const imagesBySource = new Map(output.images.map((image) => [image.source, image.bytes]));
  const pagesBySource = new Map<string, { pageNumber: number; pageNumbers: Set<number> }>();
  const visit = (element: OpenDataLoaderElement) => {
    if (element.type === "image" && typeof element.source === "string" && imagesBySource.has(element.source)) {
      const existing = pagesBySource.get(element.source);
      if (existing) existing.pageNumbers.add(element["page number"]);
      else pagesBySource.set(element.source, { pageNumber: element["page number"], pageNumbers: new Set([element["page number"]]) });
    }
    for (const child of elementChildren(element)) visit(child);
  };
  for (const element of output.json.kids) visit(element);
  const markdownPages = splitMarkdownByPage(output.markdown, output.json["number of pages"]);
  for (const image of output.images) {
    const markdownPageNumbers = markdownPages
      .map((markdown, index) => markdown.includes(image.source) ? index + 1 : null)
      .filter((pageNumber): pageNumber is number => pageNumber !== null);
    if (!markdownPageNumbers.length) continue;
    const existing = pagesBySource.get(image.source);
    if (existing) {
      for (const pageNumber of markdownPageNumbers) existing.pageNumbers.add(pageNumber);
    } else {
      pagesBySource.set(image.source, { pageNumber: markdownPageNumbers[0], pageNumbers: new Set(markdownPageNumbers) });
    }
  }
  return [...pagesBySource.entries()].map(([source, location], index) => ({
    imageId: `image-${index + 1}`,
    pageNumber: location.pageNumber,
    pageNumbers: [...location.pageNumbers].sort((left, right) => left - right),
    source,
    bytes: imagesBySource.get(source)!,
  }));
}

function analysisFromImage(image: { providerMetadata?: ChatDocumentProviderMetadata }): { visibleText: string | null; mainVisuals: string | null } | null {
  const analysis = image.providerMetadata?.analysis;
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return null;
  const value = analysis as Record<string, unknown>;
  return {
    visibleText: typeof value.visibleText === "string" ? value.visibleText : null,
    mainVisuals: typeof value.mainVisuals === "string" ? value.mainVisuals : null,
  };
}

function documentImageMarkdownUrl(documentId: string, conversationId: string, imageId: string): string {
  return `/api/chat/documents/${encodeURIComponent(documentId)}/images/${encodeURIComponent(imageId)}?conversationId=${encodeURIComponent(conversationId)}`;
}

function markdownForPage(markdown: string, candidates: readonly DocumentImageCandidate[], images: readonly ChatDocumentImage[], pageNumber: number, documentId: string, conversationId: string): string {
  let value = markdown;
  const storedImageIds = new Set(images.filter((image) => image.storageObjectId).map((image) => image.imageId));
  for (const candidate of candidates) {
    if (!storedImageIds.has(candidate.imageId)) continue;
    value = value.split(candidate.source).join(documentImageMarkdownUrl(documentId, conversationId, candidate.imageId));
  }
  for (const candidate of candidates) {
    if (!candidate.pageNumbers?.includes(pageNumber)) continue;
    const image = images.find((item) => item.imageId === candidate.imageId);
    const analysis = image ? analysisFromImage(image) : null;
    if (!analysis) continue;
    value += `\n\n[PDF image ${candidate.imageId}]\nVisible text: ${analysis.visibleText ?? "none"}\nVisual description: ${analysis.mainVisuals ?? "none"}`;
  }
  return value.trim();
}

function createPdfPages(output: OpenDataLoaderPdfOutput, images: readonly ChatDocumentImage[], candidates: readonly DocumentImageCandidate[], documentId: string, conversationId: string): ChatDocumentPage[] {
  const elementsByPage = new Map<number, OpenDataLoaderElement[]>();
  const topLevelElementsByPage = new Map<number, OpenDataLoaderElement[]>();
  for (const element of output.json.kids) {
    collectPageElements(element, elementsByPage);
    const page = element["page number"];
    const current = topLevelElementsByPage.get(page) ?? [];
    current.push(element);
    topLevelElementsByPage.set(page, current);
  }
  const markdownPages = splitMarkdownByPage(output.markdown, output.json["number of pages"]);
  return Array.from({ length: output.json["number of pages"] }, (_, index) => {
    const pageNumber = index + 1;
    const elements = elementsByPage.get(pageNumber) ?? [];
    const text = pageText(topLevelElementsByPage.get(pageNumber) ?? []);
    const mathDiagnostics = diagnosePdfMathExtraction({
      text,
      visualElementCount: elements.length,
      imageCount: elements.filter((element) => element.type === "image").length,
      renderedPageAvailable: true,
    });
    const pageMarkdown = markdownForPage(markdownPages[index] ?? "", candidates, images, pageNumber, documentId, conversationId);
    return {
      pageNumber,
      text,
       markdown: `${pageMarkdown}${mathDiagnostics.needsVisualInspection ? "\n\n[PDF extraction warning: visible mathematical content may be missing from native text or extraction quality is uncertain; inspect the rendered page before transcribing formulas.]" : ""}`.trim(),
      extractionMethod: text || (markdownPages[index] ?? "").trim() ? "opendataloader" : "blank",
      providerMetadata: pageProviderMetadata(elements, mathDiagnostics),
    };
  });
}

function createPdfDocument(input: PdfIngestionInput, pages: ChatDocumentPage[], images: ChatDocumentAttachment["images"]): ChatDocumentAttachment {
  const analyzedImageCount = images?.filter((image) => image.providerMetadata?.analysisStatus === "complete").length ?? 0;
  return {
    id: input.pdfId,
    name: input.filename,
    contentType: "application/pdf",
    size: input.bytes.length,
    pageCount: pages.length,
    tokenEstimate: estimatePdfTokens(pages.map((page) => documentPageMarkdown(page)).join("")),
    hasImages: Boolean(images?.length),
    imageCount: images?.length ?? 0,
    analyzedImageCount,
    imageAnalyses: [],
    providerMetadata: { provider: "opendataloader", mode: "hybrid", imageAnalysisProvider: "openrouter" },
    ...(images?.length ? { images } : {}),
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

async function registerPdf(input: PdfIngestionInput, deps: PdfIngestionDependencies, timing: DocumentIngestionTiming, document: ChatDocumentAttachment, pages: ChatDocumentPage[], object: StorageObject): Promise<ChatDocumentAttachment> {
  await deps.registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages, images: document.images, storageObjectId: object.objectId, timing });
  return document;
}

export function createPdfIngestor(overrides: Partial<PdfIngestionDependencies> = {}) {
  const deps: PdfIngestionDependencies = {
    convertPdfWithOpenDataLoader,
    prepareDocumentImages,
    uploadDocumentBytes,
    registerDocument,
    getStorageObjectById,
    ...overrides,
  };

  return async function ingestPdf(input: PdfIngestionInput): Promise<ChatDocumentAttachment> {
    const timing = createTiming({ documentType: "application/pdf", byteSize: input.bytes.length, alreadyUploaded: input.alreadyUploaded, timing: input.timing });
    const ownsTiming = !input.timing;
    let images: ChatDocumentImage[] = [];
    try {
      if (input.bytes.length > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "Documents must be 25 MiB or smaller.", 413);
      const output = await timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, () => deps.convertPdfWithOpenDataLoader(input.bytes, input.filename, { signal: input.signal }));
      const object = await storedPdfObject(input, deps, timing);
      const candidates = imageCandidates(output);
      const visionModel = await configuredVisionModel(input.ownerId).catch(() => null);
      images = await timing.measure(DOCUMENT_INGESTION_STAGES.PDF_IMAGE_ANALYSIS, () => deps.prepareDocumentImages({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        documentId: input.pdfId,
        filename: input.filename,
        projectId: input.projectId,
        revisionId: input.revisionId,
        candidates,
        signal: input.signal,
        visionModel,
      }));
      const pages = createPdfPages(output, images, candidates, input.pdfId, input.conversationId);
      timing.updateMetadata({ pageCount: pages.length, ocrPageCount: 0 });
      const document = createPdfDocument(input, pages, images);
      if (images.some((image) => image.providerMetadata?.analysisStatus === "failed")) timing.markFailed(DOCUMENT_INGESTION_STAGES.PDF_IMAGE_ANALYSIS);
      await registerPdf(input, deps, timing, document, pages, object);
      const skipped = images.length ? PDF_SKIPPED_STAGES : [...PDF_SKIPPED_STAGES, DOCUMENT_INGESTION_STAGES.PDF_IMAGE_ANALYSIS];
      markSkippedStages(timing, skipped);
      if (ownsTiming) finishOwnedTiming(timing, skipped);
      return document;
    } catch (error) {
      if (images.length) await deleteDocumentImages(input.ownerId, images);
      markSkippedStages(timing, [...PDF_SKIPPED_STAGES, DOCUMENT_INGESTION_STAGES.PDF_IMAGE_ANALYSIS]);
      if (ownsTiming) finishOwnedTiming(timing, [...PDF_SKIPPED_STAGES, DOCUMENT_INGESTION_STAGES.PDF_IMAGE_ANALYSIS]);
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
      (image) => analyzeDocumentImage(image.bytes, image.contentType, input.signal, visionModel, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        requestId: `${input.documentId}:image-${image.imageNumber}:analysis`,
      }).then((analysis) => ({ imageNumber: image.imageNumber, ...analysis })),
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
