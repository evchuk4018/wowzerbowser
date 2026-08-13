import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactReadHandler } from "../app/api/chat/artifacts/[artifactId]/route.ts";

const owner = { id: "owner-1" };
const objectId = "11111111-1111-4111-8111-111111111111";
const bytes = Uint8Array.from([80, 75, 3, 4, 20, 0, 0, 0]);
const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const descriptor = {
  ownerId: owner.id,
  conversationId: "conversation-1",
  objectId,
  name: "budget.xlsx",
  contentType,
  size: bytes.byteLength,
  sha256: "a".repeat(64),
};

function streamFor(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

test("spreadsheet artifacts persist through the signed artifact download route", async () => {
  const handler = createArtifactReadHandler({
    authorizeOwnerSession: async () => owner,
    readArtifactDescriptor: () => descriptor,
    openOwnedStorageObject: async () => ({
      object: { sha256: descriptor.sha256, contentType },
      stream: streamFor(bytes),
      size: bytes.byteLength,
    }),
  });

  const response = await handler(new Request("http://test/artifact"), { params: { artifactId: "artifact-xlsx-12345678901234567890" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), contentType);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="budget.xlsx"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("spreadsheet artifact downloads reject changed persisted metadata", async () => {
  const handler = createArtifactReadHandler({
    authorizeOwnerSession: async () => owner,
    readArtifactDescriptor: () => descriptor,
    openOwnedStorageObject: async () => ({
      object: { sha256: "b".repeat(64), contentType },
      stream: streamFor(bytes),
      size: bytes.byteLength,
    }),
  });
  const response = await handler(new Request("http://test/artifact"), { params: { artifactId: "artifact-xlsx-12345678901234567890" } });
  assert.equal(response.status, 409);
});
