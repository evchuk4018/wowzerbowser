import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupAbandonedStorage } from "../app/server/storage/storage-service.ts";
import { localFilesystemStorageProvider, ensureApplicationStorageDirectories } from "../app/server/storage/local-filesystem-storage.ts";

const ownerId = "owner";
const object = {
  objectId: "11111111-1111-4111-8111-111111111111",
  ownerId,
  conversationId: null,
  documentId: null,
  messageId: null,
  projectId: null,
  chatProjectId: null,
  revisionId: null,
  kind: "other",
  objectKey: "objects/11111111-1111-4111-8111-111111111111",
  originalFilename: null,
  contentType: "application/octet-stream",
  size: 0,
  sha256: null,
  state: "failed",
  createdAt: new Date(0).toISOString(),
  completedAt: null,
};

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    listAbandonedStorageObjects: async () => [object],
    deleteObjectFile: async () => { calls.push("file"); },
    deleteStorageObjectMetadata: async () => { calls.push("metadata"); },
    cleanupTemporaryFiles: async () => { calls.push("temporary"); return 0; },
    ...overrides,
  };
}

async function withCapturedWarnings(operation) {
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (value) => warnings.push(value);
  try {
    return { result: await operation(), warnings };
  } finally {
    console.warn = previousWarn;
  }
}

test("preserves metadata and does not count an object when physical deletion fails", async () => {
  let metadataDeleted = false;
  const deps = dependencies({
    deleteObjectFile: async () => {
      deps.calls.push("file");
      throw new Error("permission denied");
    },
    deleteStorageObjectMetadata: async () => { metadataDeleted = true; },
  });

  const { result, warnings } = await withCapturedWarnings(() => cleanupAbandonedStorage({ ownerId, limit: 1 }, deps));

  assert.equal(result, 0);
  assert.equal(metadataDeleted, false);
  assert.deepEqual(deps.calls, ["file", "temporary"]);
  assert.match(warnings[0], /"phase":"file"/);
});

test("does not count an object when metadata deletion fails after the file is removed", async () => {
  let metadataAttempted = false;
  const deps = dependencies({
    deleteStorageObjectMetadata: async () => {
      deps.calls.push("metadata");
      metadataAttempted = true;
      throw new Error("database unavailable");
    },
  });

  const { result, warnings } = await withCapturedWarnings(() => cleanupAbandonedStorage({ ownerId, limit: 1 }, deps));

  assert.equal(result, 0);
  assert.equal(metadataAttempted, true);
  assert.deepEqual(deps.calls, ["file", "metadata", "temporary"]);
  assert.match(warnings[0], /"phase":"metadata"/);
});

test("removes stale metadata and counts an object whose physical file is already missing", async () => {
  const previousRoot = process.env.APP_STORAGE_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "wowzerbowser-storage-maintenance-"));
  process.env.APP_STORAGE_ROOT = root;
  try {
    await ensureApplicationStorageDirectories();
    const deps = dependencies({
      deleteObjectFile: async (candidate) => {
        deps.calls.push("file");
        await localFilesystemStorageProvider.deleteObjectFile(candidate);
      },
    });

    const result = await cleanupAbandonedStorage({ ownerId, limit: 1 }, deps);

    assert.equal(result, 1);
    assert.deepEqual(deps.calls, ["file", "metadata", "temporary"]);
  } finally {
    if (previousRoot === undefined) delete process.env.APP_STORAGE_ROOT;
    else process.env.APP_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
