import assert from "node:assert/strict";
import test from "node:test";
import { executeInspectWorkspaceImageTool } from "../app/server/agent/workspace-image-tool.ts";
import { INSPECT_WORKSPACE_IMAGE_TOOL_NAME } from "../app/server/agent/workspace-image-tool-manifest.ts";

const call = (args) => ({ id: "image-call", name: INSPECT_WORKSPACE_IMAGE_TOOL_NAME, arguments: JSON.stringify(args) });
const context = (bytes, path = "photos/IMG_1794.jpeg") => ({
  ownerId: "owner",
  conversationId: "conversation",
  jobId: "job",
  signal: AbortSignal.timeout(10_000),
  responseDeadlineAt: Date.now() + 10_000,
  executor: { readWorkspaceFile: async (requestedPath) => { assert.equal(requestedPath, path); return bytes; } },
});

test("workspace image inspection validates bytes and records provider usage", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0xff, 0xd9]);
  let inspected;
  let usage;
  const result = await executeInspectWorkspaceImageTool(call({ path: "photos/IMG_1794.jpeg", question: "What is visible?" }), context(bytes), {
    configuredVisionModel: async () => "vision-test",
    askOpenRouterAboutImage: async (prompt, input, contentType, options) => { inspected = { prompt, input, contentType, options }; return { content: "A test image.", model: "vision-test", usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }; },
    recordPromptUsage: async (input) => { usage = input; return null; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "A test image.");
  assert.deepEqual(inspected.input, bytes);
  assert.equal(inspected.contentType, "image/jpeg");
  assert.match(inspected.prompt, /What is visible/);
  assert.equal(usage.requestKind, "image_followup");
  assert.equal(usage.model, "vision-test");
});

test("workspace image inspection rejects MP4 paths before reading them", async () => {
  let read = false;
  const result = await executeInspectWorkspaceImageTool(call({ path: "videos/clip.mp4", question: "Describe it." }), {
    ...context(new Uint8Array()),
    executor: { readWorkspaceFile: async () => { read = true; throw new Error("should not read"); } },
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MP4/);
  assert.equal(read, false);
});
