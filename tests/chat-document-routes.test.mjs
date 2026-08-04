import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ChatDocumentError } from "../lib/chat-document.ts";
import { createUploadHandler } from "../app/api/chat/documents/upload/route.ts";
import { createDocumentImageReadHandler } from "../app/api/chat/documents/[documentId]/images/[imageId]/route.ts";
import { createFinalizeHandler, maxDuration, runtime } from "../app/api/chat/documents/finalize/route.ts";
import nextConfig from "../next.config.ts";

const objectId = "11111111-1111-4111-8111-111111111111";
const storageObject = { objectId, ownerId: "owner", conversationId: "conversation", documentId: "document", messageId: null, projectId: null, revisionId: null, kind: "document", objectKey: `objects/${objectId}`, originalFilename: "a.pdf", contentType: "application/pdf", size: 8, sha256: "a".repeat(64), state: "complete", createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };

test("document upload route rejects unauthorized calls before reading bytes", async () => {
  const handler = createUploadHandler({ authorizeOwnerSession: async () => null });
  const response = await handler(new Request("http://test", { method: "POST" }));
  assert.equal(response.status, 401);
});

test("document upload route streams an authenticated body into one pending object", async () => {
  let received;
  const handler = createUploadHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => undefined,
    ensureChatDocumentConversation: async () => undefined,
    createDocumentStorageUpload: async (input) => ({ ...storageObject, ...input, state: "uploading", size: 0, sha256: null, completedAt: null }),
    writePendingStorageObject: async (input) => {
      received = input;
      return storageObject;
    },
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/pdf", "content-length": "8", "x-conversation-id": "conversation", "x-document-id": "document", "x-file-name": "a.pdf" }, body: new Uint8Array(8) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).storageObjectId, objectId);
  assert.equal(received.ownerId, "owner");
  assert.equal(received.object.objectId, objectId);
  assert.equal(received.source instanceof ReadableStream, true);
});

test("document upload route reports a missing local schema as a structured 503", async () => {
  const handler = createUploadHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => { throw new ChatDocumentError("document_schema_unavailable", "The document database schema is not ready.", 503); },
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/pdf", "x-conversation-id": "conversation", "x-document-id": "document" }, body: new Uint8Array([1]) }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The document database schema is not ready." });
});

test("document schema validation checks the storage object primary key", async () => {
  const source = await readFile(new URL("../app/server/chat/chat-document-store.ts", import.meta.url), "utf8");
  assert.match(source, /select object_id from app_storage_objects limit 0/);
  assert.doesNotMatch(source, /select storage_object_id from app_storage_objects limit 0/);
});

test("finalize route uses the Node runtime and long duration required for PDF ingestion", () => {
  assert.equal(runtime, "nodejs");
  assert.equal(maxDuration, 300);
});

test("the worker owns the native PDF runtime while web routes keep the external packages available", () => {
  assert.deepEqual(nextConfig.serverExternalPackages, ["@napi-rs/canvas", "@opendataloader/pdf", "pdfjs-dist"]);
  assert.equal(nextConfig.outputFileTracingIncludes, undefined);
});

test("document image route keeps derived images owner- and conversation-scoped", async () => {
  const handler = createDocumentImageReadHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    openAuthorizedDocumentImage: async () => ({
      object: { ...storageObject, kind: "document-image", contentType: "image/png", originalFilename: "chart.png" },
      stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }),
      size: 3,
    }),
  });
  const response = await handler(new Request("http://test?conversationId=conversation"), { params: { documentId: "document", imageId: "image-1" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test("finalize route only enqueues owner-scoped processing and never parses in the web request", async () => {
  let enqueueInput;
  const handler = createFinalizeHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => undefined,
    enqueueDocumentProcessingJob: async (input) => {
      enqueueInput = input;
      return { jobId: "processing-job", documentId: input.documentId, status: "queued", error: null, progress: {}, document: null, createdAt: "", updatedAt: "" };
    },
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conversation", documentId: "document", storageObjectId: objectId, userMessageId: "message", jobId: "job", contentType: "application/pdf" }) }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).processingJobId, "processing-job");
  assert.equal(enqueueInput.storageObjectId, objectId);
  assert.equal(enqueueInput.sourceJobId, "job");
});

test("finalize route redacts queue failures", async () => {
  const handler = createFinalizeHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => undefined,
    enqueueDocumentProcessingJob: async () => { throw new Error("secret-provider-token"); },
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conversation", documentId: "document", storageObjectId: objectId, userMessageId: "message", jobId: "job", contentType: "application/pdf" }) }));
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, "The document could not be queued for background processing.");
  assert.doesNotMatch(JSON.stringify(payload), /secret-provider-token/);
});
