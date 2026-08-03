import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applicationFilesRoot,
  applicationStorageRoot,
  cleanupApplicationTemporaryFiles,
  deleteApplicationObjectFile,
  ensureApplicationStorageDirectories,
  readApplicationObject,
  writeApplicationObject,
} from "../app/server/storage/local-filesystem-storage.ts";
import { validateStorageObjectKey } from "../lib/storage-protocol.ts";

const objectId = "11111111-1111-4111-8111-111111111111";
const object = {
  objectId,
  ownerId: "owner",
  conversationId: "conversation",
  documentId: null,
  messageId: null,
  projectId: null,
  revisionId: null,
  kind: "other",
  objectKey: `objects/${objectId}`,
  originalFilename: "payload.bin",
  contentType: "application/octet-stream",
  size: 0,
  sha256: null,
  state: "uploading",
  createdAt: new Date().toISOString(),
  completedAt: null,
};

let root;
let previousRoot;

test.beforeEach(async () => {
  previousRoot = process.env.APP_STORAGE_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "wowzerbowser-storage-"));
  process.env.APP_STORAGE_ROOT = root;
});

test.afterEach(async () => {
  if (previousRoot === undefined) delete process.env.APP_STORAGE_ROOT;
  else process.env.APP_STORAGE_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

test("writes streamed bytes through a temporary file and atomically renames the UUID object", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);
  const source = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close(); } });
  const result = await writeApplicationObject({ object, source, maxBytes: 100 });
  assert.equal(result.size, bytes.byteLength);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await readFile(path.join(applicationFilesRoot(), "objects", objectId)), Buffer.from(bytes));
  assert.deepEqual(await readdir(path.join(applicationFilesRoot(), ".tmp")), []);

  const opened = await readApplicationObject({ ...object, size: bytes.byteLength });
  assert.deepEqual(new Uint8Array(await new Response(opened.stream).arrayBuffer()), bytes);
});

test("rejects traversal and absolute object keys before touching the filesystem", async () => {
  assert.throws(() => validateStorageObjectKey("objects/../outside"));
  assert.throws(() => validateStorageObjectKey("/srv/storage/media/file"));
  assert.throws(() => validateStorageObjectKey("objects/11111111-1111-4111-8111-111111111111/child"));
  await assert.rejects(writeApplicationObject({ object: { ...object, objectKey: "objects/../outside" }, source: new Uint8Array([1]), maxBytes: 100 }));
  assert.deepEqual(await readdir(root), ["files"]);
});

test("rejects the protected media root as an application storage root", () => {
  process.env.APP_STORAGE_ROOT = "/srv/storage/media";
  assert.throws(() => applicationStorageRoot(), /media directory/);
});

test("enforces a bounded upload and removes its temporary file on failure", async () => {
  await assert.rejects(writeApplicationObject({ object, source: new Uint8Array(101), maxBytes: 100 }), /maximum size/);
  await ensureApplicationStorageDirectories();
  assert.deepEqual(await readdir(path.join(applicationFilesRoot(), ".tmp")), []);
  assert.deepEqual(await readdir(path.join(applicationFilesRoot(), "objects")), []);
});

test("removes an interrupted upload without publishing a partial object", async () => {
  async function* interruptedSource() {
    yield Uint8Array.from([1, 2, 3]);
    throw new Error("source interrupted");
  }
  await assert.rejects(
    writeApplicationObject({ object, source: interruptedSource(), maxBytes: 100 }),
    /source interrupted/,
  );
  await ensureApplicationStorageDirectories();
  assert.deepEqual(await readdir(path.join(applicationFilesRoot(), ".tmp")), []);
  assert.deepEqual(await readdir(path.join(applicationFilesRoot(), "objects")), []);
});

test("refuses an application object directory that is a symlink", async (t) => {
  await ensureApplicationStorageDirectories();
  const objects = path.join(applicationFilesRoot(), "objects");
  const realObjects = path.join(applicationFilesRoot(), "objects-real");
  const outside = path.join(root, "outside-objects");
  await mkdir(outside);
  await rename(objects, realObjects);
  try {
    try {
      await symlink(outside, objects, "junction");
    } catch (error) {
      await rename(realObjects, objects);
      if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("directory symlink creation is unavailable on this runner");
      throw error;
    }
    await assert.rejects(
      writeApplicationObject({ object, source: new Uint8Array([1]), maxBytes: 100 }),
      /real directory/,
    );
  } finally {
    await unlink(objects).catch(() => undefined);
    await rename(realObjects, objects).catch(() => undefined);
  }
});

test("refuses to delete a symlink presented as an object", async (t) => {
  await ensureApplicationStorageDirectories();
  const outside = path.join(root, "outside.bin");
  const target = path.join(applicationFilesRoot(), "objects", objectId);
  await writeFile(outside, "outside");
  try {
    await symlink(outside, target);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("symlink creation is unavailable on this runner");
    throw error;
  }
  await assert.rejects(deleteApplicationObjectFile(object), /regular file/);
  assert.equal(await readFile(outside, "utf8"), "outside");
  await unlink(target);
});

test("cleans only bounded, stale temporary uploads", async () => {
  await ensureApplicationStorageDirectories();
  const temporary = path.join(applicationFilesRoot(), ".tmp", "a-stale.uploading");
  const fresh = path.join(applicationFilesRoot(), ".tmp", "z-fresh.uploading");
  await writeFile(temporary, "old");
  await writeFile(fresh, "new");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(temporary, old, old);
  assert.equal(await cleanupApplicationTemporaryFiles({ olderThanMs: 60 * 60 * 1_000, limit: 1 }), 1);
  assert.deepEqual((await readdir(path.join(applicationFilesRoot(), ".tmp"))).sort(), ["z-fresh.uploading"]);
});
