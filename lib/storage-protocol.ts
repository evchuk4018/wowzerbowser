import {
  isStorageObjectId,
  STORAGE_OBJECT_ID_PATTERN,
  STORAGE_OBJECT_KEY_PATTERN,
  STORAGE_OBJECT_KINDS,
  STORAGE_OBJECT_STATES,
  validateStorageObjectKey,
} from "./storage-protocol.mjs";

export {
  isStorageObjectId,
  STORAGE_OBJECT_ID_PATTERN,
  STORAGE_OBJECT_KEY_PATTERN,
  STORAGE_OBJECT_KINDS,
  STORAGE_OBJECT_STATES,
  validateStorageObjectKey,
};

export type StorageObjectState = (typeof STORAGE_OBJECT_STATES)[number];
export type StorageObjectKind = (typeof STORAGE_OBJECT_KINDS)[number];

export type StorageObject = {
  objectId: string;
  ownerId: string;
  conversationId: string | null;
  documentId: string | null;
  messageId: string | null;
  projectId: string | null;
  revisionId: string | null;
  kind: StorageObjectKind;
  objectKey: string;
  originalFilename: string | null;
  contentType: string;
  size: number;
  sha256: string | null;
  state: StorageObjectState;
  createdAt: string;
  completedAt: string | null;
};

export type StorageObjectInput = {
  ownerId: string;
  conversationId?: string | null;
  documentId?: string | null;
  messageId?: string | null;
  projectId?: string | null;
  revisionId?: string | null;
  kind: StorageObjectKind;
  originalFilename?: string | null;
  contentType: string;
};

export type StorageObjectSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type StorageObjectRead = {
  stream: ReadableStream<Uint8Array>;
  size: number;
};

/** Provider-neutral boundary shared by application services and maintenance adapters. */
export interface StorageProvider {
  writeObject(input: { object: StorageObject; source: StorageObjectSource; maxBytes: number; signal?: AbortSignal }): Promise<{ size: number; sha256: string }>;
  readObject(object: StorageObject): Promise<StorageObjectRead>;
  readObjectBytes(object: StorageObject): Promise<Uint8Array>;
  deleteObjectFile(object: StorageObject): Promise<void>;
  cleanupTemporaryFiles(input: { olderThanMs: number; limit: number }): Promise<number>;
}
