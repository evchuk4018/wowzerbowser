import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { OpenRouterImageError, askOpenRouterAboutImage } from "../app/providers/openrouter/openrouter-image-adapter.ts";
import { renderPdfPage, renderPdfPagesSettled } from "../app/server/chat/pdf-page-renderer.ts";
import { isTransientPdfOcrFailure, ocrPdfPages } from "../app/server/chat/pdf-page-ocr.ts";
import { parsePdfNatively } from "../app/server/chat/pdf-native-parser.ts";

const renderedPages = (pageNumbers) => pageNumbers.map((pageNumber) => ({ pageNumber, bytes: new Uint8Array([pageNumber]), contentType: "image/png" }));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("native pages never reach OCR and selected pages run concurrently in page order", async () => {
  const pages = [1, 2, 3, 4, 5, 6].map((pageNumber) => ({ pageNumber, nativeText: pageNumber % 2 ? `native-${pageNumber}` : "", needsOcr: pageNumber % 2 === 0 }));
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const result = await ocrPdfPages({
    pages,
    renderedPages: renderedPages([2, 4, 6]),
    concurrency: 2,
    retryDelayMs: 0,
    ocrPage: async (page) => {
      calls.push(page.pageNumber);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await wait({ 2: 25, 4: 10, 6: 1 }[page.pageNumber]);
      active -= 1;
      return `ocr-${page.pageNumber}`;
    },
  });

  assert.deepEqual(calls.sort((a, b) => a - b), [2, 4, 6]);
  assert.equal(maximumActive, 2);
  assert.deepEqual(result.map((page) => page.pageNumber), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.map((page) => page.extractionMethod), ["native", "ocr", "native", "ocr", "native", "ocr"]);
  assert.deepEqual(result.map((page) => page.text), ["native-1", "ocr-2", "native-3", "ocr-4", "native-5", "ocr-6"]);
});

test("retries transient provider failures but not permanent validation failures", async () => {
  const attempts = new Map();
  const result = await ocrPdfPages({
    pages: [2, 4, 6].map((pageNumber) => ({ pageNumber, nativeText: pageNumber === 6 ? "native fallback" : "", needsOcr: true })),
    renderedPages: renderedPages([2, 4, 6]),
    concurrency: 1,
    maxRetries: 2,
    retryDelayMs: 0,
    ocrPage: async (page) => {
      const count = (attempts.get(page.pageNumber) ?? 0) + 1;
      attempts.set(page.pageNumber, count);
      if (page.pageNumber === 2 && count < 3) throw new OpenRouterImageError("transport", "temporary failure");
      if (page.pageNumber === 2) return "ocr-2";
      if (page.pageNumber === 4) throw new OpenRouterImageError("no_vision_model", "permanent validation failure", 400);
      throw new OpenRouterImageError("upstream", "temporary failure");
    },
  });

  assert.equal(attempts.get(2), 3);
  assert.equal(attempts.get(4), 1);
  assert.equal(attempts.get(6), 3);
  assert.deepEqual(result.map((page) => [page.pageNumber, page.text, page.extractionMethod]), [
    [2, "ocr-2", "ocr"],
    [4, "", "blank"],
    [6, "native fallback", "native"],
  ]);
  assert.equal(result[1].failure.code, "no_vision_model");
  assert.equal(result[2].failure.code, "upstream");
});

test("cancellation stops queued work and waits for active work to observe AbortSignal", async () => {
  const controller = new AbortController();
  const calls = [];
  const promise = ocrPdfPages({
    pages: [1, 2, 3, 4, 5].map((pageNumber) => ({ pageNumber, nativeText: "", needsOcr: true })),
    renderedPages: renderedPages([1, 2, 3, 4, 5]),
    concurrency: 2,
    retryDelayMs: 0,
    signal: controller.signal,
    ocrPage: async (page, { signal }) => {
      calls.push(page.pageNumber);
      await new Promise((resolve, reject) => {
        const abort = () => reject(new OpenRouterImageError("cancelled", "cancelled", 499));
        signal.addEventListener("abort", abort, { once: true });
        setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 100);
      });
      return `ocr-${page.pageNumber}`;
    },
  });
  await wait(5);
  controller.abort();
  await assert.rejects(promise, (error) => error.code === "parser_cancelled" && error.status === 499);
  assert.deepEqual(calls.sort((a, b) => a - b), [1, 2]);
});

test("ten-page scanned fixture is scored page-by-page for OCR", async () => {
  const bytes = await readFile(new URL("./fixtures/documents/ten-page-scanned.pdf", import.meta.url));
  const native = await parsePdfNatively(bytes);
  assert.equal(native.pageCount, 10);
  assert.deepEqual(native.pages.map((page) => page.pageNumber), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.ok(native.pageOcrDecisions.every((decision) => decision.needsOcr));
});

test("rendered OCR pages stay within configured dimensions and byte limits", async () => {
  const bytes = await readFile(new URL("./fixtures/documents/ten-page-scanned.pdf", import.meta.url));
  const rendered = await renderPdfPage(bytes, 1, { maxWidth: 300, maxHeight: 400, maxPixels: 120_000, maxBytes: 100_000 });
  assert.ok(rendered.width <= 300);
  assert.ok(rendered.height <= 400);
  assert.ok(rendered.width * rendered.height <= 120_000);
  assert.ok(rendered.bytes.byteLength <= 100_000);
  assert.equal(rendered.contentType, "image/png");
});

test("a render failure is isolated to its optional page", async () => {
  const bytes = await readFile(new URL("./fixtures/documents/ten-page-scanned.pdf", import.meta.url));
  const batch = await renderPdfPagesSettled(bytes, [1, 11], { maxWidth: 300, maxHeight: 400 });
  assert.deepEqual(batch.renderedPages.map((page) => page.pageNumber), [1]);
  assert.equal(batch.failures.get(11).code, "pdf_page_render_failed");
});

test("OpenRouter HTTP status classes only retry transient provider failures", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0, 0, 0, 0, 0,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  try {
    for (const status of [401, 403, 413, 422, 429, 500, 503]) {
      await assert.rejects(
        askOpenRouterAboutImage("OCR", png, "image/png", { fetchImpl: async () => new Response("failure", { status }) }),
        (error) => {
          assert.equal(isTransientPdfOcrFailure(error), status === 429 || status >= 500);
          return true;
        },
      );
    }
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
