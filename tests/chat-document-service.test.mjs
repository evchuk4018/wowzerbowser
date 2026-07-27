import assert from "node:assert/strict";
import test from "node:test";
import { ChatDocumentError } from "../lib/chat-document.ts";
import { createPdfIngestor } from "../app/server/chat/chat-document-service.ts";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming } from "../app/server/chat/document-ingestion-timing.ts";

const signedUrl = "https://storage.test/storage/v1/object/sign/chat-documents/owner/conversation/document.pdf?token=secret";

function documentInput(overrides = {}) {
  return {
    ownerId: "owner",
    conversationId: "conversation",
    pdfId: "document",
    filename: "document.pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 45]),
    userMessageId: "message",
    jobId: "job",
    timing: new DocumentIngestionTiming({ documentType: "application/pdf", byteSize: 5 }),
    ...overrides,
  };
}

function nativeExtraction() {
  return {
    pageCount: 1,
    textItemCount: 1,
    imageObjectCount: 0,
    pages: [{ pageNumber: 1, text: "native text", textItemCount: 1, imageObjectCount: 0, pageWidth: 612, pageHeight: 792 }],
    pageOcrDecisions: [{ needsOcr: false, score: 0, reasons: ["native_text_accepted"], nativeTextConfidence: 1 }],
    extractionQuality: { hasTextLayer: true, pagesWithText: 1, pagesWithoutText: 0, pagesWithImages: 0, emptyPageCount: 0, textCharacterCount: 12, imageObjectCountAvailable: true },
  };
}

test("native PDF ingestion does not call the external parser or sign a URL", async () => {
  const calls = [];
  let registered;
  const ingestPdf = createPdfIngestor({
    parsePdfNatively: async () => { calls.push("native"); return nativeExtraction(); },
    createSignedDocumentDownloadUrl: async () => { calls.push("signed"); return signedUrl; },
    parsePdfWithOpenRouter: async () => { calls.push("external"); throw new Error("not called"); },
    registerDocument: async (input) => { calls.push("register"); registered = input; },
  });

  const result = await ingestPdf(documentInput({ alreadyUploaded: true }));

  assert.deepEqual(calls, ["native", "register"]);
  assert.equal(result.pageCount, 1);
  assert.equal(result.imageCount, 0);
  assert.equal(registered.pages[0].text, "native text");
});

test("recoverable native PDF failures use the free parser after uploading and lazily signing", async () => {
  const calls = [];
  let registered;
  const ingestPdf = createPdfIngestor({
    parsePdfNatively: async () => { calls.push("native"); throw new ChatDocumentError("pdf_parser_failed", "native parser failed", 400); },
    uploadDocumentBytes: async (path) => { calls.push(["upload", path]); },
    createSignedDocumentDownloadUrl: async (input) => { calls.push(["signed", input.documentId]); return signedUrl; },
    parsePdfWithOpenRouter: async (url) => { calls.push(["external", url]); return [{ pageNumber: 99, text: "fallback text", extractionMethod: "native" }]; },
    registerDocument: async (input) => { calls.push("register"); registered = input; },
  });

  const result = await ingestPdf(documentInput({ alreadyUploaded: false }));
  const timing = result && registered.timing.toLogEntry();

  assert.deepEqual(calls, [
    "native",
    ["upload", "owner/conversation/document.pdf"],
    ["signed", "document"],
    ["external", signedUrl],
    "register",
  ]);
  assert.equal(result.pageCount, 1);
  assert.equal(result.tokenEstimate, 4);
  assert.deepEqual(registered.pages, [{ pageNumber: 1, text: "fallback text", extractionMethod: "native" }]);
  assert.equal(timing.fallbackUsed, true);
  assert.equal(timing.failedStage, DOCUMENT_INGESTION_STAGES.NATIVE_PARSING);
  assert.ok(timing.stages[DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING] !== undefined);
});

test("oversized and cancelled native failures never invoke the PDF fallback", async () => {
  for (const code of ["document_too_large", "parser_cancelled"]) {
    let externalCalls = 0;
    const ingestPdf = createPdfIngestor({
      parsePdfNatively: async () => { throw new ChatDocumentError(code, code, code === "document_too_large" ? 413 : 499); },
      parsePdfWithOpenRouter: async () => { externalCalls += 1; return []; },
      uploadDocumentBytes: async () => { throw new Error("upload should not run"); },
      registerDocument: async () => { throw new Error("register should not run"); },
    });

    await assert.rejects(ingestPdf(documentInput({ alreadyUploaded: false })), (error) => error instanceof ChatDocumentError && error.code === code);
    assert.equal(externalCalls, 0);
  }
});

test("external fallback failures do not register a partial PDF", async () => {
  let registerCalls = 0;
  const ingestPdf = createPdfIngestor({
    parsePdfNatively: async () => { throw new ChatDocumentError("pdf_parser_failed", "native parser failed", 400); },
    createSignedDocumentDownloadUrl: async () => signedUrl,
    parsePdfWithOpenRouter: async () => { throw new ChatDocumentError("parser_unavailable", "provider unavailable", 502); },
    registerDocument: async () => { registerCalls += 1; },
  });

  await assert.rejects(ingestPdf(documentInput({ alreadyUploaded: true })), (error) => error instanceof ChatDocumentError && error.code === "parser_unavailable");
  assert.equal(registerCalls, 0);
});
