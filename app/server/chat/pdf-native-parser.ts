import "server-only";

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ChatDocumentError, MAX_PDF_BYTES, type ChatDocumentPageCandidate, type NativePdfExtraction } from "../../../lib/chat-document";

const IMAGE_OPERATORS = new Set([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
]);

type TextItem = { str: string; hasEOL?: boolean };

export type PdfNativeParserOptions = { signal?: AbortSignal };

function parserError(message: string, status = 400): ChatDocumentError {
  return new ChatDocumentError("pdf_parser_failed", message, status);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF parser request was cancelled.", 499);
}

function isTextItem(item: unknown): item is TextItem {
  if (!item || typeof item !== "object" || !("str" in item)) return false;
  return typeof item.str === "string";
}

function textFromItems(items: readonly unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!isTextItem(item)) continue;
    if (item.str) {
      if (text && !text.endsWith("\n") && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
      text += item.str;
    }
    if (item.hasEOL && !text.endsWith("\n")) text += "\n";
  }
  return text.trim();
}

type OperatorList = { fnArray?: readonly number[]; argsArray?: readonly unknown[] };

function imageObjectCount(operatorList: OperatorList): number {
  const imageObjectKeys = new Set<string>();
  let anonymousImageCount = 0;
  for (const [index, operator] of (operatorList.fnArray ?? []).entries()) {
    if (!IMAGE_OPERATORS.has(operator)) continue;
    const args = operatorList.argsArray?.[index];
    const objectId = Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
    if (objectId) imageObjectKeys.add(objectId);
    else anonymousImageCount += 1;
  }
  return imageObjectKeys.size + anonymousImageCount;
}

async function countImageObjects(page: { getOperatorList: () => Promise<OperatorList> }): Promise<{ count: number; available: boolean }> {
  try {
    const operatorList = await page.getOperatorList();
    return { count: imageObjectCount(operatorList), available: true };
  } catch {
    // Image counting is supplemental. A broken or unsupported image should
    // not discard text that PDF.js successfully extracted from the page.
    return { count: 0, available: false };
  }
}

function pageCandidate(input: {
  pageNumber: number;
  text: string;
  textItemCount: number;
  imageObjectCount: number;
  pageWidth: number;
  pageHeight: number;
}): ChatDocumentPageCandidate {
  return input;
}

export async function parsePdfNatively(bytes: Uint8Array, options: PdfNativeParserOptions = {}): Promise<NativePdfExtraction> {
  const { signal } = options;
  throwIfAborted(signal);
  if (bytes.length > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "PDFs must be 25 MiB or smaller.", 413);
  if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw parserError("The uploaded file is not a valid PDF.");

  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    loadingTask = getDocument({
      data: Uint8Array.from(bytes),
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      useWasm: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw parserError("The PDF does not contain any pages.");

    const pages: ChatDocumentPageCandidate[] = [];
    let textItemCount = 0;
    let imageObjectCount = 0;
    let pagesWithText = 0;
    let pagesWithImages = 0;
    let textCharacterCount = 0;
    let imageObjectCountAvailable = true;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      try {
        const [textContent, imageObjects] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false }),
          countImageObjects(page),
        ]);
        const items = textContent.items as readonly unknown[];
        const pageTextItemCount = items.filter(isTextItem).length;
        const text = textFromItems(items);
        const viewport = page.getViewport({ scale: 1 });
        const candidate = pageCandidate({
          pageNumber,
          text,
          textItemCount: pageTextItemCount,
          imageObjectCount: imageObjects.count,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
        });
        pages.push(candidate);
        textItemCount += candidate.textItemCount;
        imageObjectCount += candidate.imageObjectCount;
        textCharacterCount += candidate.text.length;
        if (candidate.text.length > 0) pagesWithText += 1;
        if (candidate.imageObjectCount > 0) pagesWithImages += 1;
        imageObjectCountAvailable = imageObjectCountAvailable && imageObjects.available;
      } finally {
        page.cleanup();
      }
    }

    return {
      pageCount: pdf.numPages,
      textItemCount,
      imageObjectCount,
      pages,
      extractionQuality: {
        hasTextLayer: textCharacterCount > 0,
        pagesWithText,
        pagesWithoutText: pdf.numPages - pagesWithText,
        pagesWithImages,
        emptyPageCount: pages.filter((page) => page.text.length === 0).length,
        textCharacterCount,
        imageObjectCountAvailable,
      },
    };
  } catch (error) {
    if (error instanceof ChatDocumentError) throw error;
    if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF parser request was cancelled.", 499);
    throw parserError("The uploaded PDF could not be parsed.");
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}

// These aliases keep the parser easy to discover for callers using either
// the noun-first or verb-first naming convention.
export const parseNativePdf = parsePdfNatively;
export const parsePdfNative = parsePdfNatively;
