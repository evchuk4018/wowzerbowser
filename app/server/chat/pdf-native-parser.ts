import "server-only";

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ChatDocumentError, MAX_PDF_BYTES, type ChatDocumentPageCandidate, type NativePdfExtraction } from "../../../lib/chat-document";
import { decidePdfPageOcr } from "./pdf-page-ocr-decision";

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

type TextItem = { str: string; hasEOL?: boolean; width?: number; height?: number };

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

type ImageAnalysis = { count: number; largeImageCoverage: number | null; available: boolean };

type Matrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function matrixFromArgs(args: unknown): Matrix | null {
  if (!Array.isArray(args) || args.length < 6 || args.slice(0, 6).some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  return args.slice(0, 6) as Matrix;
}

function imageAnalysis(operatorList: OperatorList, pageArea: number): ImageAnalysis {
  const imageObjectKeys = new Set<string>();
  let anonymousImageCount = 0;
  let paintedArea = 0;
  let matrix: Matrix = [...IDENTITY_MATRIX];
  const stack: Matrix[] = [];
  for (const [index, operator] of (operatorList.fnArray ?? []).entries()) {
    const args = operatorList.argsArray?.[index];
    if (operator === OPS.save) {
      stack.push([...matrix]);
      continue;
    }
    if (operator === OPS.restore) {
      matrix = stack.pop() ?? [...IDENTITY_MATRIX];
      continue;
    }
    if (operator === OPS.transform) {
      const transform = matrixFromArgs(args);
      if (transform) matrix = multiplyMatrices(matrix, transform);
      continue;
    }
    if (!IMAGE_OPERATORS.has(operator)) continue;
    const objectId = Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
    if (objectId) imageObjectKeys.add(objectId);
    else anonymousImageCount += 1;
    const area = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
    if (Number.isFinite(area)) paintedArea += area;
  }
  const count = imageObjectKeys.size + anonymousImageCount;
  return { count, largeImageCoverage: count > 0 && pageArea > 0 ? Math.min(1, paintedArea / pageArea) : null, available: true };
}

async function countImageObjects(page: { getOperatorList: () => Promise<OperatorList> }, pageArea: number): Promise<ImageAnalysis> {
  try {
    const operatorList = await page.getOperatorList();
    return imageAnalysis(operatorList, pageArea);
  } catch {
    // Image counting is supplemental. A broken or unsupported image should
    // not discard text that PDF.js successfully extracted from the page.
    return { count: 0, largeImageCoverage: null, available: false };
  }
}

function textCoverage(items: readonly unknown[], pageArea: number): number | null {
  if (!(pageArea > 0)) return null;
  let area = 0;
  let measured = false;
  for (const item of items) {
    if (!isTextItem(item) || typeof item.width !== "number" || typeof item.height !== "number") continue;
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) continue;
    measured = true;
    area += Math.abs(item.width * item.height);
  }
  return measured ? Math.min(1, area / pageArea) : null;
}

function normalizedLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}

function repeatedHeaderFooterOnlyText(texts: readonly string[]): boolean[] {
  const lineCounts = new Map<string, number>();
  const pageLines = texts.map(normalizedLines);
  for (const lines of pageLines) {
    for (const line of new Set([lines[0], lines.at(-1)].filter((value): value is string => Boolean(value)))) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }
  const repeated = new Set([...lineCounts.entries()].filter(([, count]) => count >= 2).map(([line]) => line));
  return pageLines.map((lines) => lines.length > 0 && lines.every((line) => repeated.has(line)));
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
    const pageOcrInputs: Array<{
      text: string;
      textItemCount: number;
      imageObjectCount: number;
      largeImageCoverage: number | null;
      visibleContentCoverage: number | null;
      visualAnalysisAvailable: boolean;
    }> = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const [textContent, imageObjects] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false }),
          countImageObjects(page, viewport.width * viewport.height),
        ]);
        const items = textContent.items as readonly unknown[];
        const pageTextItemCount = items.filter(isTextItem).length;
        const text = textFromItems(items);
        const measuredTextCoverage = textCoverage(items, viewport.width * viewport.height);
        const visibleContentCoverage = imageObjects.largeImageCoverage === null && measuredTextCoverage === null
          ? null
          : Math.min(1, (imageObjects.largeImageCoverage ?? 0) + (measuredTextCoverage ?? 0));
        const candidate = pageCandidate({
          pageNumber,
          text,
          textItemCount: pageTextItemCount,
          imageObjectCount: imageObjects.count,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
        });
        pages.push(candidate);
        pageOcrInputs.push({
          text,
          textItemCount: pageTextItemCount,
          imageObjectCount: imageObjects.count,
          largeImageCoverage: imageObjects.largeImageCoverage,
          visibleContentCoverage,
          visualAnalysisAvailable: imageObjects.available,
        });
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

    const repeatedHeaderFooterFlags = repeatedHeaderFooterOnlyText(pageOcrInputs.map((page) => page.text));
    const pageOcrDecisions = pageOcrInputs.map((page, index) => decidePdfPageOcr({
      ...page,
      repeatedHeaderFooterOnly: repeatedHeaderFooterFlags[index],
    }));
    throwIfAborted(signal);

    return {
      pageCount: pdf.numPages,
      textItemCount,
      imageObjectCount,
      pages,
      pageOcrDecisions,
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
