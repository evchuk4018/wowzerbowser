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
    if (String(url).endsWith("/upload")) {
      assert.equal(init.method, "POST");
      const uploadHeaders = new Headers(init.headers);
      assert.equal(uploadHeaders.get("content-type"), DOCX_CONTENT_TYPE);
      assert.equal(uploadHeaders.get("x-conversation-id"), "conversation-1");
      assert.equal(uploadHeaders.get("x-document-id"), "document-1");
      return new Response(JSON.stringify({ storageObjectId: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (String(url).endsWith("/finalize")) {
      return new Response(JSON.stringify({ processingJobId: "processing-job", status: "queued" }), { status: 202 });
    }
    if (String(url).includes("/api/chat/documents/jobs/")) {
      return new Response(JSON.stringify({ jobId: "processing-job", status: "completed", progress: { stage: "completed" }, document: attachment }), { status: 200 });
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
      ["/api/chat/documents/upload", "POST"],
      ["/api/chat/documents/finalize", "POST"],
      ["/api/chat/documents/jobs/conversation-1/processing-job", "GET"],
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
