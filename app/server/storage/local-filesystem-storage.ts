import "server-only";

import type { StorageObject, StorageObjectSource, StorageProvider } from "../../../lib/storage-protocol";
import * as filesystem from "../../../lib/local-filesystem-storage.mjs";

export const APPLICATION_FILES_DIRECTORY = filesystem.APPLICATION_FILES_DIRECTORY;
export const APPLICATION_OBJECTS_DIRECTORY = filesystem.APPLICATION_OBJECTS_DIRECTORY;
export const APPLICATION_TEMP_DIRECTORY = filesystem.APPLICATION_TEMP_DIRECTORY;
export const DEFAULT_APPLICATION_STORAGE_ROOT = filesystem.DEFAULT_APPLICATION_STORAGE_ROOT;

export const applicationStorageRoot = filesystem.applicationStorageRoot;
export const applicationFilesRoot = filesystem.applicationFilesRoot;
export const ensureApplicationStorageDirectories = filesystem.ensureApplicationStorageDirectories;
export const cleanupApplicationTemporaryFiles = filesystem.cleanupApplicationTemporaryFiles;

export function writeApplicationObject(input: {
  object: StorageObject;
  source: StorageObjectSource;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ size: number; sha256: string }> {
  return filesystem.writeApplicationObject(input);
}

export function readApplicationObject(object: StorageObject): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  return filesystem.readApplicationObject(object);
}

export function readApplicationObjectBytes(object: StorageObject): Promise<Uint8Array> {
  return filesystem.readApplicationObjectBytes(object);
}

export function deleteApplicationObjectFile(object: StorageObject): Promise<void> {
  return filesystem.deleteApplicationObjectFile(object);
}

export const localFilesystemStorageProvider: StorageProvider = {
  writeObject: writeApplicationObject,
  readObject: readApplicationObject,
  readObjectBytes: readApplicationObjectBytes,
  deleteObjectFile: deleteApplicationObjectFile,
  cleanupTemporaryFiles: cleanupApplicationTemporaryFiles,
};
