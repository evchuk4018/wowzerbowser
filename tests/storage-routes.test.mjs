import assert from "node:assert/strict";
import test from "node:test";
import { ChatDocumentError } from "../lib/chat-document.ts";
import { createArtifactReadHandler } from "../app/api/chat/artifacts/[artifactId]/route.ts";
import { createDocumentReadHandler } from "../app/api/chat/documents/[documentId]/route.ts";
import { createDeleteHandler } from "../app/api/chat/documents/delete/route.ts";

const owner = { id: "owner" };
const objectId = "11111111-1111-4111-8111-111111111111";
const bytes = Uint8Array.from([37, 80, 68, 70, 45, 49]);
const sha256 = "a".repeat(64);

function streamFor(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

async function responseBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

test("document reads require the owner session and stream exact scoped bytes", async () => {
  const calls = [];
  const object = {
    originalFilename: "invoice\"2026.pdf",
    contentType: "application/pdf",
  };
  const handler = createDocumentReadHandler({
    authorizeOwnerSession: async () => owner,
    openAuthorizedDocument: async (...input) => {
      calls.push(input);
      if (input[1] !== "conversation") return null;
      return { object, stream: streamFor(bytes), size: bytes.byteLength };
    },
  });

  const unauthorized = await createDocumentReadHandler({
    authorizeOwnerSession: async () => null,
    openAuthorizedDocument: async () => {
      throw new Error("must not read");
    },
  })(new Request("http://test/doc"), { params: { documentId: "document-1" } });
  assert.equal(unauthorized.status, 401);

  const invalid = await handler(
    new Request("http://test/doc?conversationId=conversation"),
    { params: { documentId: "" } },
  );
  assert.equal(invalid.status, 404);
  assert.equal(calls.length, 0);

  const response = await handler(
    new Request("http://test/doc?conversationId=conversation"),
    { params: Promise.resolve({ documentId: "document-1" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBytes(response), bytes);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"invoice_2026.pdf\"");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(calls[0], ["owner", "conversation", "document-1"]);

  const crossConversation = await handler(
    new Request("http://test/doc?conversationId=other"),
    { params: { documentId: "document-1" } },
  );
  assert.equal(crossConversation.status, 404);
  assert.deepEqual(calls.at(-1), ["owner", "other", "document-1"]);
});

test("document reads redact storage changes as a conflict", async () => {
  const handler = createDocumentReadHandler({
    authorizeOwnerSession: async () => owner,
    openAuthorizedDocument: async () => {
      throw new ChatDocumentError("document_storage_changed", "The document changed.", 409);
    },
  });
  const response = await handler(
    new Request("http://test/doc?conversationId=conversation"),
    { params: { documentId: "document-1" } },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "The document changed." });
});

test("artifact reads verify the signed metadata and stream exact bytes", async () => {
  const artifactId = "artifact-id-123456789012";
  const descriptor = {
    ownerId: "owner",
    conversationId: "conversation",
    objectId,
    name: "report\"\n.pdf",
    contentType: "application/pdf",
    size: bytes.byteLength,
    sha256,
  };
  const openedObject = { sha256, contentType: "application/pdf" };
  const calls = [];
  const handler = createArtifactReadHandler({
    authorizeOwnerSession: async () => owner,
    readArtifactDescriptor: (id, ownerId) => id === artifactId && ownerId === owner.id ? descriptor : null,
    openOwnedStorageObject: async (input) => {
      calls.push(input);
      return { object: openedObject, stream: streamFor(bytes), size: bytes.byteLength };
    },
  });

  const unauthorized = await createArtifactReadHandler({
    authorizeOwnerSession: async () => null,
    readArtifactDescriptor: () => {
      throw new Error("must not read");
    },
    openOwnedStorageObject: async () => {
      throw new Error("must not open");
    },
  })(new Request("http://test/artifact"), { params: { artifactId } });
  assert.equal(unauthorized.status, 401);

  const invalid = await handler(
    new Request("http://test/artifact"),
    { params: { artifactId: "bad!" } },
  );
  assert.equal(invalid.status, 404);

  const response = await handler(
    new Request("http://test/artifact"),
    { params: { artifactId } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBytes(response), bytes);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"report__.pdf\"");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(calls[0], { ownerId: "owner", objectId, conversationId: "conversation" });

  const changedHandler = createArtifactReadHandler({
    authorizeOwnerSession: async () => owner,
    readArtifactDescriptor: () => descriptor,
    openOwnedStorageObject: async () => ({
      object: { sha256, contentType: "text/plain" },
      stream: streamFor(bytes),
      size: bytes.byteLength,
    }),
  });
  const changed = await changedHandler(
    new Request("http://test/artifact"),
    { params: { artifactId } },
  );
  assert.equal(changed.status, 409);
});

test("document deletion validates identifiers and forwards the authenticated owner", async () => {
  let deleted;
  const handler = createDeleteHandler({
    authorizeOwnerSession: async () => owner,
    deleteDocument: async (input) => {
      deleted = input;
    },
  });

  const invalid = await handler(new Request("http://test/doc", {
    method: "DELETE",
    body: JSON.stringify({
      conversationId: "../media",
      documentId: "document-1",
      contentType: "application/pdf",
    }),
  }));
  assert.equal(invalid.status, 400);
  assert.equal(deleted, undefined);

  const response = await handler(new Request("http://test/doc", {
    method: "DELETE",
    body: JSON.stringify({
      conversationId: "conversation",
      documentId: "document-1",
      contentType: "application/pdf",
    }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(deleted, {
    ownerId: "owner",
    conversationId: "conversation",
    documentId: "document-1",
    contentType: "application/pdf",
  });
});
