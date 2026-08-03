import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseMemoryUpdate } from "../lib/memory-protocol.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("memory update protocol accepts content and rejects malformed payloads", () => {
  assert.deepEqual(parseMemoryUpdate({ content: "User studies calculus." }), { content: "User studies calculus." });
  assert.deepEqual(parseMemoryUpdate({ content: "" }), { content: "" });
  assert.equal(parseMemoryUpdate(null), null);
  assert.equal(parseMemoryUpdate({ content: 42 }), null);
  assert.equal(parseMemoryUpdate([]), null);
});

test("memory summaries are owner-scoped, ordered, and exclude empty values", async () => {
  const repository = await source("app/server/chat/chat-summary-store.ts");
  assert.match(repository, /chat_conversation_summaries/);
  assert.match(repository, /chat_conversation_summaries/);
  assert.match(repository, /where summaries\.owner_id=\$1/);
  assert.match(repository, /order by summaries\.updated_at desc/);
  assert.match(repository, /databaseOwnerId\(ownerId\)/);
  assert.match(repository, /row\.summary\.trim\(\)\.length > 0/);
  assert.match(repository, /title: row\.title \?\? "Conversation"/);
});

test("memory API routes authenticate owners and keep handlers thin", async () => {
  const [viewRoute, mutationRoute] = await Promise.all([
    source("app/api/memory/route.ts"),
    source("app/api/memory/[memoryId]/route.ts"),
  ]);
  assert.match(viewRoute, /authorizeOwnerSession/);
  assert.match(viewRoute, /getMemoryView\(owner\.id\)/);
  assert.match(mutationRoute, /authorizeOwnerSession/);
  assert.match(mutationRoute, /parseMemoryUpdate/);
  assert.match(mutationRoute, /updateUserMemoryFromSettings/);
  assert.match(mutationRoute, /deleteUserMemoryFromSettings/);
  assert.match(mutationRoute, /status: 401/);
  assert.match(mutationRoute, /status: 404/);
});

test("Settings mutations preserve provenance and bypass revision auditing", async () => {
  const [repository, settingsService] = await Promise.all([
    source("app/server/memory/user-memory-repository.ts"),
    source("app/server/memory/user-memory-service.ts"),
  ]);
  assert.match(repository, /editUserMemoryFromSettings/);
  assert.match(repository, /deleteUserMemoryFromSettings/);
  assert.match(repository, /content=\$1,content_fingerprint=\$2/);
  const editStart = repository.indexOf("export async function editUserMemoryFromSettings");
  const moveStart = repository.indexOf("export async function moveUserMemory", editStart);
  const deleteStart = repository.indexOf("export async function deleteUserMemoryFromSettings");
  assert.doesNotMatch(repository.slice(editStart, moveStart), /audit\(/);
  assert.doesNotMatch(repository.slice(deleteStart), /audit\(/);
  assert.match(settingsService, /validateContent\(content\)/);
  assert.match(settingsService, /UserMemoryDuplicateError/);
});

test("settings replaces the Plugins placeholder while preserving Tools", async () => {
  const settings = await source("app/settings/settings-modal.tsx");
  assert.match(settings, /id: "memory", label: "Memory"/);
  assert.match(settings, /activeSection === "memory"/);
  assert.match(settings, /<MemorySettings/);
  assert.match(settings, /<ToolsSettings/);
  assert.doesNotMatch(settings, /id: "plugins"/);
});
