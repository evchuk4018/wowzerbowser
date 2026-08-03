import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { validateStorageObjectKey } from "./storage-protocol.mjs";

export const APPLICATION_FILES_DIRECTORY = "files";
export const APPLICATION_OBJECTS_DIRECTORY = "objects";
export const APPLICATION_TEMP_DIRECTORY = ".tmp";
export const DEFAULT_APPLICATION_STORAGE_ROOT = "/srv/storage/wowzerbowser";
const FORBIDDEN_MEDIA_ROOT = path.resolve("/srv/storage/media");

function assertOutsideForbiddenMedia(root) {
  const relativeToMedia = path.relative(FORBIDDEN_MEDIA_ROOT, root);
  if (relativeToMedia === "" || (!relativeToMedia.startsWith("..") && !path.isAbsolute(relativeToMedia))) {
    throw new Error("Application storage cannot use the media directory.");
  }
}

export function applicationStorageRoot() {
  const configured = process.env.APP_STORAGE_ROOT?.trim() || DEFAULT_APPLICATION_STORAGE_ROOT;
  const root = path.resolve(configured);
  assertOutsideForbiddenMedia(root);
  return root;
}

export function applicationFilesRoot() {
  return path.join(applicationStorageRoot(), APPLICATION_FILES_DIRECTORY);
}

async function assertDirectoryNotSymlink(directory) {
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`Storage path is not a real directory: ${directory}`);
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
  await assertDirectoryNotSymlink(directory);
}

export async function ensureApplicationStorageDirectories() {
  const root = applicationStorageRoot();
  await ensureDirectory(root);
  const resolvedRoot = await realpath(root);
  assertOutsideForbiddenMedia(resolvedRoot);
  const filesRoot = applicationFilesRoot();
  await ensureDirectory(filesRoot);
  await ensureDirectory(path.join(filesRoot, APPLICATION_OBJECTS_DIRECTORY));
  await ensureDirectory(path.join(filesRoot, APPLICATION_TEMP_DIRECTORY));
}

function relativeStoragePath(objectKey) {
  const key = validateStorageObjectKey(objectKey);
  const filesRoot = applicationFilesRoot();
  const objectId = key.slice(APPLICATION_OBJECTS_DIRECTORY.length + 1);
  const absolute = path.join(filesRoot, APPLICATION_OBJECTS_DIRECTORY, objectId);
  const relative = path.relative(filesRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("The storage object path escapes the application root.");
  return absolute;
}

async function assertRegularFileWithoutFollowingSymlinks(filePath) {
  const value = await lstat(filePath);
  if (!value.isFile() || value.isSymbolicLink()) throw new Error("The storage object is not a regular file.");
}

async function assertObjectDirectoriesAreSafe() {
  await assertDirectoryNotSymlink(applicationStorageRoot());
  await assertDirectoryNotSymlink(applicationFilesRoot());
  await assertDirectoryNotSymlink(path.join(applicationFilesRoot(), APPLICATION_OBJECTS_DIRECTORY));
}

async function* sourceChunks(source) {
  if (source instanceof Uint8Array) {
    if (source.byteLength) yield source;
    return;
  }
  if (typeof source?.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        if (!(result.value instanceof Uint8Array)) throw new Error("Storage streams must yield byte chunks.");
        if (result.value.byteLength) yield result.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  else {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Storage streams must yield byte chunks.");
      if (chunk.byteLength) yield chunk;
    }
  }
}

export async function writeApplicationObject(input) {
  await ensureApplicationStorageDirectories();
  const target = relativeStoragePath(input.object.objectKey);
  const temporary = path.join(applicationFilesRoot(), APPLICATION_TEMP_DIRECTORY, `${randomUUID()}.uploading`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of sourceChunks(input.source)) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Storage upload was cancelled.");
      size += chunk.byteLength;
      if (!Number.isSafeInteger(size) || size > input.maxBytes) throw new Error("The storage object exceeds its maximum size.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    await assertDirectoryNotSymlink(path.dirname(target));
    await rename(temporary, target);
    return { size, sha256: digest.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readApplicationObject(object) {
  await assertObjectDirectoriesAreSafe();
  const filePath = relativeStoragePath(object.objectKey);
  await assertRegularFileWithoutFollowingSymlinks(filePath);
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const details = await handle.stat();
  if (!details.isFile()) {
    await handle.close();
    throw new Error("The storage object is not a regular file.");
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const result = await handle.read(buffer, 0, buffer.byteLength, null);
        if (!result.bytesRead) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(buffer.subarray(0, result.bytesRead)));
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
  return { stream, size: details.size };
}

export async function readApplicationObjectBytes(object) {
  const opened = await readApplicationObject(object);
  const reader = opened.stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function deleteApplicationObjectFile(object) {
  await assertObjectDirectoriesAreSafe();
  const filePath = relativeStoragePath(object.objectKey);
  try {
    const value = await lstat(filePath);
    if (value.isSymbolicLink() || !value.isFile()) throw new Error("The storage object is not a regular file.");
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function cleanupApplicationTemporaryFiles(input) {
  if (input.limit <= 0) return 0;
  await ensureApplicationStorageDirectories();
  const directory = path.join(applicationFilesRoot(), APPLICATION_TEMP_DIRECTORY);
  const cutoff = Date.now() - Math.max(0, input.olderThanMs);
  let removed = 0;
  const inspectionLimit = Math.max(1, input.limit);
  const handle = await opendir(directory);
  try {
    let inspected = 0;
    for await (const entry of handle) {
      if (inspected >= inspectionLimit) break;
      inspected += 1;
      if (removed >= inspectionLimit || !entry.name.endsWith(".uploading")) continue;
      const target = path.join(directory, entry.name);
      const details = await lstat(target).catch(() => null);
      if (!details || details.isSymbolicLink() || !details.isFile() || details.mtimeMs > cutoff) continue;
      await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      removed += 1;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return removed;
}

export const localFilesystemStorageProvider = {
  writeObject: writeApplicationObject,
  readObject: readApplicationObject,
  readObjectBytes: readApplicationObjectBytes,
  deleteObjectFile: deleteApplicationObjectFile,
  cleanupTemporaryFiles: cleanupApplicationTemporaryFiles,
};
