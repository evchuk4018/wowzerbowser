import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatProjectProtocolError,
  parseCreateChatProjectInput,
  parseCreateChatProjectChatInput,
  parseUpdateChatProjectInput,
  validateChatProjectFileMetadata,
} from "../lib/chat-project-protocol.ts";

test("chat project protocol normalizes bounded project inputs", () => {
  assert.deepEqual(parseCreateChatProjectInput({ title: "  Research  ", instructions: "  Use primary sources.  " }), {
    title: "Research",
    instructions: "Use primary sources.",
  });
  assert.deepEqual(parseUpdateChatProjectInput({ instructions: "" }), { instructions: "" });
  assert.deepEqual(parseCreateChatProjectChatInput({ title: "  New thread ", conversationId: "thread_1" }), {
    title: "New thread",
    conversationId: "thread_1",
  });
});

test("chat project protocol rejects oversized and malformed metadata", () => {
  assert.throws(() => parseCreateChatProjectInput({ title: "" }), ChatProjectProtocolError);
  assert.throws(() => parseCreateChatProjectInput({ title: "ok", instructions: "x".repeat(12_001) }), ChatProjectProtocolError);
  assert.throws(() => parseUpdateChatProjectInput({}), ChatProjectProtocolError);
  assert.throws(() => validateChatProjectFileMetadata({
    id: "not-a-uuid",
    projectId: "project_1",
    name: "notes.txt",
    contentType: "text/plain",
    size: 10,
    sha256: null,
    state: "complete",
    createdAt: new Date().toISOString(),
  }), ChatProjectProtocolError);
});

test("chat project file metadata stays provider-neutral", () => {
  assert.deepEqual(validateChatProjectFileMetadata({
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project_1",
    name: "notes.txt",
    contentType: "text/plain",
    size: 10,
    sha256: "a".repeat(64),
    state: "complete",
    createdAt: "2026-08-06T12:00:00.000Z",
  }), {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project_1",
    name: "notes.txt",
    contentType: "text/plain",
    size: 10,
    sha256: "a".repeat(64),
    state: "complete",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
});
