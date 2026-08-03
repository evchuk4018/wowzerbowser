export const STORAGE_OBJECT_STATES = ["uploading", "complete", "failed"] as const;
export type StorageObjectState = (typeof STORAGE_OBJECT_STATES)[number];

export const STORAGE_OBJECT_KINDS = [
  "document",
  "image",
  "artifact",
  "revision-source",
  "other",
] as const;
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

export const STORAGE_OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const STORAGE_OBJECT_KEY_PATTERN = /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStorageObjectId(value: unknown): value is string {
  return typeof value === "string" && STORAGE_OBJECT_ID_PATTERN.test(value);
}

export function validateStorageObjectKey(value: unknown): string {
  if (typeof value !== "string" || !STORAGE_OBJECT_KEY_PATTERN.test(value) || value.includes("\\") || value.includes("..")) {
    throw new Error("The storage object key is invalid.");
  }
  return value;
}
