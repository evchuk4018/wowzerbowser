import "server-only";

import { createHash } from "node:crypto";
import type { StorageObject, StorageObjectInput } from "../../../lib/storage-protocol";
import {
  localFilesystemStorageProvider,
} from "./local-filesystem-storage";
import {
  completeStorageObject,
  createStorageObject,
  deleteStorageObjectMetadata,
  failStorageObject,
  getStorageObjectById,
  listAbandonedStorageObjects,
  listStorageObjectsForConversation,
} from "./storage-repository";

export async function createPendingStorageObject(input: StorageObjectInput): Promise<StorageObject> {
  return createStorageObject(input);
}

export async function storeStorageObject(input: {
  metadata: StorageObjectInput;
  source: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<StorageObject> {
  const object = await createPendingStorageObject(input.metadata);
  return writePendingStorageObject({ ownerId: input.metadata.ownerId, object, source: input.source, maxBytes: input.maxBytes, signal: input.signal });
}

export async function writePendingStorageObject(input: {
  ownerId: string;
  object: StorageObject;
  source: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<StorageObject> {
  try {
    const result = await localFilesystemStorageProvider.writeObject({ object: input.object, source: input.source, maxBytes: input.maxBytes, signal: input.signal });
    return await completeStorageObject({ ownerId: input.ownerId, objectId: input.object.objectId, size: result.size, sha256: result.sha256 });
  } catch (error) {
    await failStorageObject({ ownerId: input.ownerId, objectId: input.object.objectId }).catch(() => undefined);
    await localFilesystemStorageProvider.deleteObjectFile(input.object).catch(() => undefined);
    throw error;
  }
}

export async function completePendingStorageObject(input: { ownerId: string; objectId: string; maxBytes: number }): Promise<StorageObject> {
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId, state: "uploading" });
  if (!object) throw new Error("The pending storage object was not found.");
  const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
  if (bytes.byteLength > input.maxBytes) throw new Error("The storage object exceeds its maximum size.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return completeStorageObject({ ownerId: input.ownerId, objectId: input.objectId, size: bytes.byteLength, sha256 });
}

export async function openOwnedStorageObject(input: { ownerId: string; objectId: string; conversationId?: string }): Promise<{ object: StorageObject; stream: ReadableStream<Uint8Array>; size: number }> {
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId, conversationId: input.conversationId, state: "complete" });
  if (!object) throw new Error("The storage object was not found.");
  const opened = await localFilesystemStorageProvider.readObject(object);
  if (opened.size !== object.size) throw new Error("The storage object size does not match its metadata.");
  return { object, ...opened };
}

export async function deleteOwnedStorageObject(input: { ownerId: string; objectId: string }): Promise<void> {
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId });
  if (!object) return;
  await localFilesystemStorageProvider.deleteObjectFile(object);
  await deleteStorageObjectMetadata(input);
}

export async function deleteStorageObjectsForConversation(ownerId: string, conversationId: string, excludeChatProjectId?: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const objects = await listStorageObjectsForConversation(ownerId, conversationId, 1_000, excludeChatProjectId);
    if (!objects.length) return deleted;
    for (const object of objects) {
      await localFilesystemStorageProvider.deleteObjectFile(object);
      await deleteStorageObjectMetadata({ ownerId, objectId: object.objectId });
      deleted += 1;
    }
    if (objects.length < 1_000) return deleted;
  }
}

export async function cleanupAbandonedStorage(input: { ownerId: string; now?: Date; olderThanMs?: number; limit?: number }): Promise<number> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const olderThanMs = input.olderThanMs ?? 60 * 60 * 1_000;
  const objects = await listAbandonedStorageObjects(input.ownerId, new Date((input.now ?? new Date()).getTime() - olderThanMs), limit);
  let cleaned = 0;
  for (const object of objects) {
    await localFilesystemStorageProvider.deleteObjectFile(object).catch(() => undefined);
    await deleteStorageObjectMetadata({ ownerId: input.ownerId, objectId: object.objectId }).catch(() => undefined);
    cleaned += 1;
  }
  cleaned += await localFilesystemStorageProvider.cleanupTemporaryFiles({ olderThanMs, limit: Math.max(0, limit - cleaned) });
  return cleaned;
}
