import assert from "node:assert/strict";
import test from "node:test";
import { ChatImageFetchError } from "../app/chat/chat-service.ts";
import { CHAT_IMAGE_PREVIEW_DELAYS_MS, loadChatImagePreview } from "../app/chat/chat-image-preview-loader.ts";

const blob = new Blob(["image"]);
const immediateWait = async () => {};

function input(fetchImage, overrides = {}) {
  return {
    imageId: "image-1",
    conversationId: "conversation-1",
    signal: new AbortController().signal,
    hasSession: async () => true,
    fetchImage,
    wait: immediateWait,
    ...overrides,
  };
}

test("preview loader retries a transient 404 and eventually returns the image", async () => {
  let calls = 0;
  const result = await loadChatImagePreview(input(async () => {
    calls += 1;
    if (calls === 1) throw new ChatImageFetchError(404, "Not ready");
    return blob;
  }));
  assert.equal(result, blob);
  assert.equal(calls, 2);
});

test("preview loader bounds transient retries while rechecking the session", async () => {
  let fetches = 0;
  let sessionChecks = 0;
  await assert.rejects(loadChatImagePreview(input(async () => {
    fetches += 1;
    throw new ChatImageFetchError(503, "Unavailable");
  }, { hasSession: async () => { sessionChecks += 1; return true; } })), /Unavailable/);
  assert.equal(fetches, CHAT_IMAGE_PREVIEW_DELAYS_MS.length + 1);
  assert.equal(sessionChecks, fetches);
});

test("preview loader does not retry permanent authorization failures", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    await assert.rejects(loadChatImagePreview(input(async () => {
      calls += 1;
      throw new ChatImageFetchError(status, "Denied");
    })), /Denied/);
    assert.equal(calls, 1);
  }
});

test("preview loader aborts outstanding backoff work", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = loadChatImagePreview(input(async () => {
    calls += 1;
    throw new ChatImageFetchError(409, "Processing");
  }, {
    signal: controller.signal,
    wait: (_milliseconds, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }));
  await Promise.resolve();
  controller.abort(new Error("unmounted"));
  await assert.rejects(pending, /unmounted/);
  assert.equal(calls, 1);
});
