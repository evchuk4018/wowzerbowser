import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ChatDocumentError } from "../lib/chat-document.ts";
import { createUploadHandler } from "../app/api/chat/documents/upload/route.ts";
import { createFinalizeHandler, maxDuration, runtime } from "../app/api/chat/documents/finalize/route.ts";
import nextConfig from "../next.config.ts";

const objectId = "11111111-1111-4111-8111-111111111111";
const document = { id: "document", name: "a.pdf", contentType: "application/pdf", size: 8, pageCount: 1, tokenEstimate: 1, hasImages: false, imageCount: 0, analyzedImageCount: 0, imageAnalyses: [] };
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

test("Next traces native canvas for both PDF execution routes", () => {
  assert.deepEqual(nextConfig.serverExternalPackages, ["@napi-rs/canvas", "pdfjs-dist"]);
  const includes = nextConfig.outputFileTracingIncludes;
  for (const route of ["/api/chat", "/api/chat/documents/finalize"]) {
    assert.ok(includes?.[route]?.some((entry) => entry.includes("pdfjs-dist")));
    assert.ok(includes?.[route]?.some((entry) => entry.includes("@napi-rs/canvas-linux-x64-gnu")));
    assert.ok(includes?.[route]?.some((entry) => entry.includes("@napi-rs/canvas-linux-x64-musl")));
    assert.ok(includes?.[route]?.some((entry) => entry.includes("@napi-rs/canvas-linux-arm64-gnu")));
    assert.ok(includes?.[route]?.some((entry) => entry.includes("@napi-rs/canvas-linux-arm64-musl")));
  }
});

test("finalize route reads the owner-scoped object and never accepts a URL", async () => {
  let ingestInput;
  const handler = createFinalizeHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => undefined,
    readPendingDocumentUpload: async () => ({ object: storageObject, bytes: new Uint8Array(8) }),
    ingestPdf: async (input) => { ingestInput = input; return document; },
    ingestDocx: async () => { throw new Error("not called"); },
    cleanupEmptyChatConversation: async () => undefined,
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conversation", documentId: "document", storageObjectId: objectId, userMessageId: "message", jobId: "job", contentType: "application/pdf" }) }));
  assert.equal(response.status, 200);
  assert.equal(ingestInput.storageObjectId, objectId);
  assert.equal(ingestInput.alreadyUploaded, true);
  assert.equal(ingestInput.downloadUrl, undefined);
});

test("finalize route redacts storage/parser failures", async () => {
  const handler = createFinalizeHandler({
    authorizeOwnerSession: async () => ({ id: "owner" }),
    ensureChatDocumentSchema: async () => undefined,
    readPendingDocumentUpload: async () => { throw new ChatDocumentError("document_storage_invalid", "secret-download-token", 502); },
    ingestPdf: async () => { throw new Error("not called"); },
    ingestDocx: async () => { throw new Error("not called"); },
    cleanupEmptyChatConversation: async () => undefined,
  });
  const response = await handler(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "conversation", documentId: "document", storageObjectId: objectId, userMessageId: "message", jobId: "job", contentType: "application/pdf" }) }));
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.equal(payload.failedStage, "storage-read");
  assert.equal(payload.error, "The document could not be read.");
  assert.doesNotMatch(JSON.stringify(payload), /secret-download-token/);
});
