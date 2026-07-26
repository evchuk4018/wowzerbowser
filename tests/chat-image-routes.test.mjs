import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatImageReadHandler,
} from "../app/api/chat/images/[imageId]/route.ts";
import {
  createChatImageUploadHandler,
  hasDuplicateImageIds,
  parseBoundedMultipartForm,
  readBoundedRequestBody,
  validateMultipartContentType,
} from "../app/api/chat/images/route.ts";
import {
  CHAT_IMAGE_CONTENT_TYPES,
  MAX_CHAT_IMAGES_PER_TURN,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_REQUEST_BYTES,
  ChatImageError,
  validateChatImageBytes,
} from "../lib/chat-image.ts";

const authHeaders = { authorization: "Bearer session-token" };
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0, 0, 0, 0, 0,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function uploadRequest({ ids = ["image-1"], files = [png], contentType } = {}) {
  const form = new FormData();
  form.set("conversationId", "conversation-1");
  form.set("userMessageId", "message-1");
  form.set("jobId", "job-1");
  ids.forEach((id) => form.append("imageIds", id));
  files.forEach((bytes, index) => form.append("images", new File([bytes], `image-${index}.png`, { type: "image/png" })));
  const headers = new Headers(authHeaders);
  if (contentType) headers.set("content-type", contentType);
  return new Request("http://localhost/api/chat/images", { method: "POST", headers, body: form });
}

async function json(response) {
  return response.json();
}

test("multipart transport rejects non-multipart content and oversized declared requests", async () => {
  assert.throws(
    () => validateMultipartContentType("application/json"),
    (error) => error instanceof ChatImageError && error.status === 400,
  );

  const handler = createChatImageUploadHandler({
    authorizeOwnerSession: async () => ({ id: "owner-1" }),
    analyzeAndStoreChatImages: async () => {
      throw new Error("service must not be called");
    },
  });
  const request = new Request("http://localhost/api/chat/images", {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "multipart/form-data; boundary=not-read",
      "content-length": String(MAX_CHAT_IMAGE_REQUEST_BYTES + 1),
    },
    body: "not buffered",
  });
  const response = await handler(request);
  assert.equal(response.status, 413);
  assert.deepEqual(await json(response), { error: "The image upload request is too large." });
});

test("chunked multipart transport is bounded before formData buffering", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_CHAT_IMAGE_REQUEST_BYTES + 1));
      controller.close();
    },
  });
  const request = new Request("http://localhost/api/chat/images", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=not-read" },
    body,
    duplex: "half",
  });
  await assert.rejects(
    readBoundedRequestBody(request),
    (error) => error instanceof ChatImageError && error.status === 413,
  );
});

test("upload transport rejects duplicate IDs, mismatched counts, and too many files", async () => {
  const calls = [];
  const handler = createChatImageUploadHandler({
    authorizeOwnerSession: async () => ({ id: "owner-1" }),
    analyzeAndStoreChatImages: async (...args) => {
      calls.push(args);
      return [];
    },
  });

  const duplicate = await handler(uploadRequest({ ids: ["same", "same"], files: [png, png] }));
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await json(duplicate), { error: "Image IDs must be unique." });

  const mismatched = await handler(uploadRequest({ ids: ["image-1"], files: [png, png] }));
  assert.equal(mismatched.status, 400);
  assert.match((await json(mismatched)).error, /between 1 and 4/);

  const tooMany = await handler(uploadRequest({
    ids: Array.from({ length: MAX_CHAT_IMAGES_PER_TURN + 1 }, (_, index) => `image-${index}`),
    files: Array.from({ length: MAX_CHAT_IMAGES_PER_TURN + 1 }, () => png),
  }));
  assert.equal(tooMany.status, 400);
  assert.match((await json(tooMany)).error, /between 1 and 4/);
  assert.equal(calls.length, 0);
  assert.equal(hasDuplicateImageIds(["image-1", "image-2"]), false);
  assert.equal(hasDuplicateImageIds(["image-1", "image-1"]), true);
});

test("upload transport forwards the authenticated owner, conversation, MIME declaration, and bytes", async () => {
  let call;
  const handler = createChatImageUploadHandler({
    authorizeOwnerSession: async (token) => {
      assert.equal(token, "session-token");
      return { id: "owner-from-session" };
    },
    analyzeAndStoreChatImages: async (...args) => {
      call = args;
      return [{ id: "image-1" }];
    },
  });
  const response = await handler(uploadRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { attachments: [{ id: "image-1" }] });
  assert.equal(call[0], "owner-from-session");
  assert.equal(call[1], "conversation-1");
  assert.equal(call[2], "message-1");
  assert.equal(call[3][0].id, "image-1");
  assert.equal(call[3][0].declaredType, "image/png");
  assert.deepEqual(call[3][0].bytes, png);
  assert.equal(call[4].jobId, "job-1");
});

test("upload transport rejects an oversized file before the service call", async () => {
  let called = false;
  const handler = createChatImageUploadHandler({
    authorizeOwnerSession: async () => ({ id: "owner-1" }),
    analyzeAndStoreChatImages: async () => {
      called = true;
      return [];
    },
  });
  const response = await handler(uploadRequest({ files: [new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1)] }));
  assert.equal(response.status, 413);
  assert.deepEqual(await json(response), { error: "Each image must be 10 MB or smaller." });
  assert.equal(called, false);
});

test("image signature validation rejects spoofed MIME and unsupported bytes", () => {
  assert.deepEqual(CHAT_IMAGE_CONTENT_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.equal(validateChatImageBytes(png, "image/png"), "image/png");
  assert.throws(() => validateChatImageBytes(png, "image/jpeg"), /does not match/);
  assert.throws(() => validateChatImageBytes(new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1), "image/png"), /10 MB or smaller/);
  assert.throws(() => validateChatImageBytes(new Uint8Array([1, 2, 3]), "image/png"), /supported/);
});

test("image read forwards owner and conversation and safely formats a scoped miss", async () => {
  let readInput;
  const handler = createChatImageReadHandler({
    authorizeOwnerSession: async (token) => {
      assert.equal(token, "session-token");
      return { id: "owner-from-session" };
    },
    readChatImageForOwner: async (input) => {
      readInput = input;
      if (input.ownerId !== "owner-from-session" || input.conversationId !== "conversation-1") {
        throw new ChatImageError("image_not_found", "The image was not found in this conversation.", 404);
      }
      return { bytes: png, contentType: "image/png" };
    },
  });
  const response = await handler(
    new Request("http://localhost/api/chat/images/image-1?conversationId=conversation-1", { headers: authHeaders }),
    { params: Promise.resolve({ imageId: "image-1" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.deepEqual(readInput, {
    ownerId: "owner-from-session",
    conversationId: "conversation-1",
    imageId: "image-1",
  });

  const miss = createChatImageReadHandler({
    authorizeOwnerSession: async () => ({ id: "owner-from-session" }),
    readChatImageForOwner: async () => {
      throw new ChatImageError("image_not_found", "The image was not found in this conversation.", 404);
    },
  });
  const missingResponse = await miss(
    new Request("http://localhost/api/chat/images/image-1?conversationId=other-conversation", { headers: authHeaders }),
    { params: Promise.resolve({ imageId: "image-1" }) },
  );
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await json(missingResponse), { error: "The image was not found in this conversation." });
});

test("malformed multipart forms return a safe client error", async () => {
  const form = new Request("http://localhost/api/chat/images", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=missing", ...authHeaders },
    body: "not a multipart body",
  });
  await assert.rejects(
    parseBoundedMultipartForm(form),
    (error) => error instanceof ChatImageError && error.status === 400 && error.code === "invalid_multipart",
  );
});
