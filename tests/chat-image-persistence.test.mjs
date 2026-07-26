import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_BYTES,
  normalizeChatImageAttachments,
  parseChatImageAttachment,
  parseChatImageToolResult,
  parseChatRequest,
} from "../lib/chat-protocol.ts";
import { applyChatStreamEvent } from "../lib/chat-history.ts";

const attachment = (overrides = {}) => ({
  id: "img_123",
  name: "screen.png",
  contentType: "image/png",
  size: 128,
  storagePath: "owner-1/conversation-1/message-1/img_123",
  analysis: {
    status: "complete",
    visibleText: "NONE",
    mainVisuals: "A settings page with a save button.",
    textModel: "vision-text",
    visualModel: "vision-visual",
  },
  ...overrides,
});

function request(overrides = {}) {
  return {
    systemPrompt: "system",
    userPresence: "",
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "high",
    messages: [{ role: "user", content: "Image attached", attachments: [attachment()] }],
    ...overrides,
  };
}

test("image attachments are normalized into provider-neutral request metadata", () => {
  const parsed = parseChatRequest(request());
  assert.equal(parsed.messages[0].attachments?.[0]?.analysis.visibleText, null);
  assert.equal(parsed.messages[0].attachments?.[0]?.storagePath, "owner-1/conversation-1/message-1/img_123");
  assert.equal(parsed.messages[0].attachments?.[0]?.analysis.mainVisuals, "A settings page with a save button.");
});

test("attachment validation rejects unsupported, oversized, URL, and duplicate metadata", () => {
  assert.throws(() => parseChatImageAttachment(attachment({ contentType: "image/svg+xml" })), /contentType is invalid/);
  assert.throws(() => parseChatImageAttachment(attachment({ size: CHAT_IMAGE_MAX_BYTES + 1 })), /size is invalid/);
  assert.throws(() => parseChatImageAttachment(attachment({ storagePath: "data:image/png;base64,AAAA" })), /storagePath is invalid/);
  assert.throws(
    () => parseChatRequest(request({ messages: [{
      role: "user",
      content: "Two images",
      attachments: [attachment(), attachment()],
    }] })),
    /duplicate image id/,
  );
  assert.throws(
    () => parseChatRequest(request({ messages: [{
      role: "user",
      content: "Too many images",
      attachments: Array.from({ length: CHAT_IMAGE_MAX_COUNT + 1 }, (_, index) => attachment({ id: `img_${index}` })),
    }] })),
    /at most 4 images/,
  );
});

test("image tool results are structured and bounded", () => {
  assert.deepEqual(parseChatImageToolResult({
    kind: "image",
    imageId: "img_123",
    question: "Is there a save button?",
    answer: "Yes.",
    model: null,
  }), {
    kind: "image",
    imageId: "img_123",
    question: "Is there a save button?",
    answer: "Yes.",
    model: null,
  });
  assert.throws(() => parseChatImageToolResult({
    kind: "image",
    imageId: "img_123",
    question: "",
    answer: "Yes.",
    model: null,
  }), /question must be a non-empty string/);
});

test("request validation preserves structured image results for replay", () => {
  const parsed = parseChatRequest(request({
    messages: [
      { role: "user", content: "Inspect this" },
      {
        role: "assistant",
        content: "I checked the image.",
        rounds: [{
          content: "",
          toolCalls: [{
            id: "inspect-1",
            name: "inspect_image",
            arguments: '{"imageId":"img_123","question":"Is it blue?"}',
            result: {
              id: "inspect-1",
              name: "inspect_image",
              ok: true,
              stdout: "",
              stderr: "",
              image: { kind: "image", imageId: "img_123", question: "Is it blue?", answer: "Yes.", model: null },
            },
          }],
        }],
      },
      { role: "user", content: "Thanks" },
    ],
  }));
  assert.deepEqual(parsed.messages[1].rounds?.[0]?.toolCalls?.[0]?.result?.image, {
    kind: "image",
    imageId: "img_123",
    question: "Is it blue?",
    answer: "Yes.",
    model: null,
  });
});

test("image tool events replay as image activities instead of web activities", () => {
  let message = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    activities: [],
    artifacts: [],
    status: "streaming",
    lastSequence: 0,
  };
  message = applyChatStreamEvent(message, {
    type: "tool_call",
    call: { id: "inspect-1", name: "inspect_image", arguments: '{"imageId":"img_123","question":"Is it blue?"}' },
  }, 1, 1_000);
  message = applyChatStreamEvent(message, {
    type: "tool_result",
    result: {
      id: "inspect-1",
      name: "inspect_image",
      ok: true,
      stdout: "",
      stderr: "",
      image: {
        kind: "image",
        imageId: "img_123",
        question: "Is it blue?",
        answer: "Yes.",
        model: "vision-model",
      },
    },
  }, 2, 1_100);
  assert.equal(message.activities?.[0]?.kind, "image");
  assert.equal(message.activities?.[0]?.result?.image?.imageId, "img_123");
  assert.equal(message.activities?.[0]?.status, "completed");
});

test("malformed persisted attachment rows are ignored without exposing unsafe metadata", () => {
  const loaded = normalizeChatImageAttachments([
    attachment(),
    attachment({ id: "img_123", storagePath: "https://example.com/image.png" }),
    attachment({ id: "img_124", analysis: { ...attachment().analysis, status: "failed" } }),
  ]);
  assert.deepEqual(loaded.map(({ id }) => id), ["img_123"]);
});

test("message-version persistence stores attachment metadata on the owning version", async () => {
  const [store, migration] = await Promise.all([
    readFile(new URL("../app/server/chat/chat-history-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260725010000_chat_image_attachments.sql", import.meta.url), "utf8"),
  ]);
  assert.match(store, /attachments: unknown/);
  assert.match(store, /attachments: message\.attachments \?\? \[\]/);
  assert.match(store, /lastMessage\.attachments/);
  assert.match(store, /version_id: versionId/);
  assert.match(migration, /add column if not exists attachments jsonb/i);
  assert.match(migration, /jsonb_typeof\(attachments\) = 'array'/i);
});
