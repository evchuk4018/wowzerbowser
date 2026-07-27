import "server-only";

import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ChatDocumentError, MAX_PDF_BYTES } from "../../../lib/chat-document";

export const PDF_RENDER_MAX_WIDTH = 2_000;
export const PDF_RENDER_MAX_HEIGHT = 2_800;
export const PDF_RENDER_MAX_PIXELS = 5_000_000;
export const PDF_RENDER_MAX_BYTES = 4 * 1024 * 1024;
export const PDF_RENDER_DEFAULT_SCALE = 2;

export type RenderedPdfPage = {
  pageNumber: number;
  bytes: Uint8Array;
  contentType: "image/png";
  width: number;
  height: number;
};

export type RenderedPdfPageBatch = {
  renderedPages: RenderedPdfPage[];
  failures: Map<number, unknown>;
};

export type PdfPageRendererOptions = {
  signal?: AbortSignal;
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxBytes?: number;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
}

function renderError(message: string, status = 400): ChatDocumentError {
  return new ChatDocumentError("pdf_page_render_failed", message, status);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function renderScale(page: { getViewport: (options: { scale: number }) => { width: number; height: number } }, options: Required<Pick<PdfPageRendererOptions, "scale" | "maxWidth" | "maxHeight" | "maxPixels">>): number {
  const base = page.getViewport({ scale: 1 });
  const dimensionScale = Math.min(options.maxWidth / base.width, options.maxHeight / base.height);
  const pixelScale = Math.sqrt(options.maxPixels / (base.width * base.height));
  const scale = Math.min(options.scale, dimensionScale, pixelScale);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

async function renderOnePage(
  pdfPage: {
    getViewport: (options: { scale: number }) => { width: number; height: number };
    render: unknown;
    cleanup: () => void;
  },
  pageNumber: number,
  options: Required<Pick<PdfPageRendererOptions, "scale" | "maxWidth" | "maxHeight" | "maxPixels" | "maxBytes">> & Pick<PdfPageRendererOptions, "signal">,
): Promise<RenderedPdfPage> {
  let scale = renderScale(pdfPage, options);
  if (scale <= 0) throw renderError("The PDF page dimensions are not renderable.", 413);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    throwIfAborted(options.signal);
    const viewport = pdfPage.getViewport({ scale });
    const width = Math.max(1, Math.min(options.maxWidth, Math.round(viewport.width)));
    const height = Math.max(1, Math.min(options.maxHeight, Math.round(viewport.height)));
    if (width * height > options.maxPixels) {
      scale *= 0.75;
      continue;
    }
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    const render = pdfPage.render as (this: typeof pdfPage, options: { canvasContext: unknown; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel: () => void };
    const renderTask = render.call(pdfPage, { canvasContext: context, viewport: { ...viewport, width, height } });
    const abort = () => renderTask.cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await renderTask.promise;
      throwIfAborted(options.signal);
      const bytes = Uint8Array.from(canvas.toBuffer("image/png"));
      if (bytes.byteLength <= options.maxBytes) return { pageNumber, bytes, contentType: "image/png", width, height };
    } catch (error) {
      if (options.signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
      if (error instanceof ChatDocumentError) throw error;
      throw renderError("The PDF page could not be rendered.");
    } finally {
      options.signal?.removeEventListener("abort", abort);
      canvas.width = 0;
      canvas.height = 0;
    }
    scale *= 0.75;
  }
  throw renderError("The rendered PDF page is too large for OCR.", 413);
}

function rendererOptions(options: PdfPageRendererOptions): Required<Pick<PdfPageRendererOptions, "scale" | "maxWidth" | "maxHeight" | "maxPixels" | "maxBytes">> & Pick<PdfPageRendererOptions, "signal"> {
  return {
    signal: options.signal,
    scale: typeof options.scale === "number" && Number.isFinite(options.scale) && options.scale > 0 ? options.scale : PDF_RENDER_DEFAULT_SCALE,
    maxWidth: positiveLimit(options.maxWidth, PDF_RENDER_MAX_WIDTH),
    maxHeight: positiveLimit(options.maxHeight, PDF_RENDER_MAX_HEIGHT),
    maxPixels: positiveLimit(options.maxPixels, PDF_RENDER_MAX_PIXELS),
    maxBytes: positiveLimit(options.maxBytes, PDF_RENDER_MAX_BYTES),
  };
}

export async function renderPdfPagesSettled(bytes: Uint8Array, pageNumbers: readonly number[], options: PdfPageRendererOptions = {}): Promise<RenderedPdfPageBatch> {
  throwIfAborted(options.signal);
  if (bytes.length > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "PDFs must be 25 MiB or smaller.", 413);
  if (!pageNumbers.length || pageNumbers.some((pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1)) throw renderError("The requested PDF page number is invalid.");
  const renderOptions = rendererOptions(options);
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  const abort = () => { void loadingTask?.destroy(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    loadingTask = getDocument({
      data: Uint8Array.from(bytes),
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      useWasm: false,
      useWorkerFetch: false,
      maxImageSize: renderOptions.maxPixels,
      canvasMaxAreaInBytes: renderOptions.maxPixels * 4,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    const results: RenderedPdfPage[] = [];
    const failures = new Map<number, unknown>();
    for (const pageNumber of pageNumbers) {
      throwIfAborted(options.signal);
      if (pageNumber > pdf.numPages) {
        failures.set(pageNumber, renderError("The requested PDF page number does not exist."));
        continue;
      }
      let page: Awaited<ReturnType<typeof pdf.getPage>>;
      try {
        page = await pdf.getPage(pageNumber);
      } catch (error) {
        if (options.signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
        failures.set(pageNumber, error);
        continue;
      }
      try {
        try {
          results.push(await renderOnePage(page, pageNumber, renderOptions));
        } catch (error) {
          if (error instanceof ChatDocumentError && error.code === "parser_cancelled") throw error;
          failures.set(pageNumber, error);
        }
      } finally {
        page.cleanup();
      }
    }
    return { renderedPages: results, failures };
  } catch (error) {
    if (error instanceof ChatDocumentError) throw error;
    if (options.signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
    throw renderError("The PDF could not be rendered.");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await loadingTask?.destroy().catch(() => undefined);
  }
}

export async function renderPdfPages(bytes: Uint8Array, pageNumbers: readonly number[], options: PdfPageRendererOptions = {}): Promise<RenderedPdfPage[]> {
  const batch = await renderPdfPagesSettled(bytes, pageNumbers, options);
  const failure = batch.failures.values().next().value;
  if (failure) throw failure instanceof ChatDocumentError ? failure : renderError("The PDF page could not be rendered.");
  return batch.renderedPages;
}

export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, options: PdfPageRendererOptions = {}): Promise<RenderedPdfPage> {
  const [page] = await renderPdfPages(bytes, [pageNumber], options);
  return page;
}
