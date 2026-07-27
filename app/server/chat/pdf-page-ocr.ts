import "server-only";

import { OpenRouterImageError, askOpenRouterToOcrPdfPage } from "../../providers/openrouter/openrouter-image-adapter";
import { ChatDocumentError, type ChatDocumentPage, type ChatDocumentPageFailure } from "../../../lib/chat-document";

export const DEFAULT_PDF_OCR_CONCURRENCY = 6;
export const MAX_PDF_OCR_CONCURRENCY = 32;
export const DEFAULT_PDF_OCR_MAX_RETRIES = 2;
export const DEFAULT_PDF_OCR_RETRY_DELAY_MS = 100;

export type PdfRenderedPage = {
  pageNumber: number;
  bytes: Uint8Array;
  contentType: "image/png";
  width?: number;
  height?: number;
};

export type PdfOcrInputPage = {
  pageNumber: number;
  nativeText: string;
  needsOcr: boolean;
};

export type PdfOcrProgress = {
  completed: number;
  total: number;
  page: ChatDocumentPage;
};

export type PdfPageOcrOptions = {
  pages: readonly PdfOcrInputPage[];
  renderedPages?: readonly PdfRenderedPage[] | ReadonlyMap<number, PdfRenderedPage>;
  renderFailures?: ReadonlyMap<number, unknown>;
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  ocrPage?: (page: PdfRenderedPage, options: { signal?: AbortSignal }) => Promise<string>;
  onProgress?: (progress: PdfOcrProgress) => void;
};

type FailureWithAttempts = ChatDocumentPageFailure & { attempts: number };

const TRANSIENT_CODES = new Set(["transport", "timeout", "rate_limit", "upstream", "temporarily_unavailable", "overloaded"]);
const PERMANENT_CODES = new Set(["missing_api_key", "no_vision_model", "provider_validation", "malformed_response", "empty_answer", "answer_too_long", "validation", "invalid_request"]);

function configuredConcurrency(value: number | undefined): number {
  const configured = value ?? Number.parseInt(process.env.PDF_OCR_CONCURRENCY ?? "", 10);
  if (!Number.isSafeInteger(configured) || configured < 1) return DEFAULT_PDF_OCR_CONCURRENCY;
  return Math.min(configured, MAX_PDF_OCR_CONCURRENCY);
}

export function getPdfOcrConcurrency(value?: number): number {
  return configuredConcurrency(value);
}

function configuredRetries(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PDF_OCR_MAX_RETRIES;
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_PDF_OCR_MAX_RETRIES;
  return Math.min(value, 5);
}

function configuredDelay(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PDF_OCR_RETRY_DELAY_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PDF_OCR_RETRY_DELAY_MS;
  return Math.min(value, 5_000);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || errorCode(error) === "cancelled" || Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

/** Provider retries are deliberately based on safe adapter classifications. */
export function isTransientPdfOcrFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (code && PERMANENT_CODES.has(code)) return false;
  if (code && TRANSIENT_CODES.has(code)) return true;
  if (error instanceof OpenRouterImageError) return error.status === 429 || error.status >= 500;
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status === 429 || error.status >= 500;
  // An unclassified error from an injected/provider transport is retryable,
  // while explicit validation-shaped errors are not.
  if (error instanceof ChatDocumentError) return false;
  return true;
}

function safeFailure(error: unknown, attempts: number): FailureWithAttempts {
  const code = errorCode(error) ?? "ocr_failed";
  const message = error instanceof OpenRouterImageError || error instanceof ChatDocumentError
    ? error.message
    : "OCR could not be completed for this page.";
  return { code, message, attempts };
}

function fallbackPage(page: PdfOcrInputPage, failure?: FailureWithAttempts): ChatDocumentPage {
  const nativeText = page.nativeText.trim();
  return {
    pageNumber: page.pageNumber,
    text: nativeText,
    extractionMethod: nativeText ? "native" : "blank",
    ...(failure ? { failure } : {}),
  };
}

function renderedPageMap(renderedPages: PdfPageOcrOptions["renderedPages"]): ReadonlyMap<number, PdfRenderedPage> {
  if (!renderedPages) return new Map();
  if ("get" in renderedPages) return renderedPages;
  return new Map(renderedPages.map((page) => [page.pageNumber, page]));
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function askWithRetries(
  page: PdfRenderedPage,
  options: Required<Pick<PdfPageOcrOptions, "maxRetries" | "retryDelayMs">> & Pick<PdfPageOcrOptions, "signal" | "ocrPage">,
): Promise<{ text: string; attempts: number }> {
  const ocrPage = options.ocrPage ?? (async (rendered, requestOptions) => (await askOpenRouterToOcrPdfPage(rendered.bytes, requestOptions)).content);
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const text = (await ocrPage(page, { signal: options.signal })).trim();
      if (!text) throw new OpenRouterImageError("empty_answer", "OCR returned no text for this page.");
      return { text, attempts: attempt };
    } catch (error) {
      if (isCancellation(error, options.signal)) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
      if (!isTransientPdfOcrFailure(error) || attempt > options.maxRetries) throw Object.assign(error instanceof Error ? error : new Error("OCR failed."), { pdfOcrAttempts: attempt });
      await waitForRetry(options.retryDelayMs * 2 ** (attempt - 1), options.signal);
    }
  }
  throw new Error("OCR retry loop ended unexpectedly.");
}

/**
 * Selects native/OCR/blank text and runs only selected pages through a bounded
 * pool. Results are written to a page-number map as each worker completes, so
 * callers can observe partial progress without exposing completion order.
 */
export async function ocrPdfPages(options: PdfPageOcrOptions): Promise<ChatDocumentPage[]> {
  const pages = [...options.pages].sort((left, right) => left.pageNumber - right.pageNumber);
  const selected = pages.filter((page) => page.needsOcr);
  const rendered = renderedPageMap(options.renderedPages);
  const results = new Map<number, ChatDocumentPage>();
  for (const page of pages) if (!page.needsOcr) results.set(page.pageNumber, fallbackPage(page));

  if (selected.length === 0) return pages.map((page) => results.get(page.pageNumber) ?? fallbackPage(page));

  const concurrency = Math.min(configuredConcurrency(options.concurrency), selected.length);
  const maxRetries = configuredRetries(options.maxRetries);
  const retryDelayMs = configuredDelay(options.retryDelayMs);
  let nextIndex = 0;
  let completed = 0;
  let cancelled = false;

  const report = (page: ChatDocumentPage) => {
    results.set(page.pageNumber, page);
    completed += 1;
    options.onProgress?.({ completed, total: selected.length, page });
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) {
        cancelled = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const page = selected[index];
      try {
        const renderFailure = options.renderFailures?.get(page.pageNumber);
        const renderedPage = rendered.get(page.pageNumber);
        if (renderFailure || !renderedPage) {
          report(fallbackPage(page, safeFailure(renderFailure ?? new Error("The page was not rendered."), 0)));
          continue;
        }
        const answer = await askWithRetries(renderedPage, { maxRetries, retryDelayMs, signal: options.signal, ocrPage: options.ocrPage });
        report({ pageNumber: page.pageNumber, text: answer.text, extractionMethod: "ocr" });
      } catch (error) {
        if (isCancellation(error, options.signal)) {
          cancelled = true;
          return;
        }
        const attempts = error && typeof error === "object" && "pdfOcrAttempts" in error && typeof error.pdfOcrAttempts === "number" ? error.pdfOcrAttempts : 1;
        report(fallbackPage(page, safeFailure(error, attempts)));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (cancelled || options.signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The PDF OCR request was cancelled.", 499);
  return pages.map((page) => results.get(page.pageNumber) ?? fallbackPage(page, { code: "ocr_cancelled", message: "OCR did not complete for this page.", attempts: 0 }));
}

export const runPdfPageOcr = ocrPdfPages;
