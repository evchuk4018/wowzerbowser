import assert from "node:assert/strict";
import test from "node:test";
import { DOCX_CONTENT_TYPE } from "../lib/chat-document.ts";
import { uploadChatDocument } from "../app/chat/chat-document-attachments.ts";

const preparedDocument = {
  id: "document-1",
  file: new File(["document bytes"], "notes.docx", { type: DOCX_CONTENT_TYPE }),
};

const attachment = {
  id: "document-1",
  name: "notes.docx",
  contentType: DOCX_CONTENT_TYPE,
  size: 13,
  pageCount: 1,
  tokenEstimate: 2,
  hasImages: false,
  imageCount: 0,
  analyzedImageCount: 0,
  imageAnalyses: [],
};

test("document preparation uploads and finalizes immediately for PDF/DOCX flows", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const stages = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/upload-url")) {
      return new Response(JSON.stringify({ signedUrl: "https://storage.test/document" }), { status: 200 });
    }
    if (String(url) === "https://storage.test/document") return new Response(null, { status: 200 });
    if (String(url).endsWith("/finalize")) {
      return new Response(JSON.stringify({ document: attachment }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await uploadChatDocument({
      conversationId: "conversation-1",
      userMessageId: "message-1",
      jobId: "job-1",
      document: preparedDocument,
      signal: new AbortController().signal,
      onStageChange: (stage) => stages.push(stage),
    });

    assert.deepEqual(result, attachment);
    assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
      ["/api/chat/documents/upload-url", "POST"],
      ["https://storage.test/document", "PUT"],
      ["/api/chat/documents/finalize", "POST"],
    ]);
    assert.deepEqual(stages, ["uploading", "parsing"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborting document preparation stops the client request without turning cancellation into a preparation error", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let observedSignal;
  globalThis.fetch = async (_url, init = {}) => {
    observedSignal = init.signal;
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };

  try {
    const promise = uploadChatDocument({
      conversationId: "conversation-1",
      userMessageId: "message-1",
      jobId: "job-1",
      document: preparedDocument,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
    assert.equal(observedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
