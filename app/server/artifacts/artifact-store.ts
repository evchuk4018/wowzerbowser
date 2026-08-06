import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatArtifact } from "../../../lib/chat-protocol";
import { isStorageObjectId, type StorageObjectKind } from "../../../lib/storage-protocol";
import { getStorageObjectById } from "../storage/storage-repository";
import { storeStorageObject } from "../storage/storage-service";

export type ArtifactDescriptor = {
  ownerId: string;
  conversationId: string;
  objectId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  workspacePath?: string;
  language?: string;
  preview?: "html" | "markdown" | "svg" | "image" | "text" | "none";
  projectId?: string;
  revisionId?: string;
  parentRevisionId?: string | null;
  origin?: "generated" | "uploaded";
  editable?: boolean;
  sourceCompleteness?: "complete" | "entrypoint-only";
};

function signingKey(): string {
  const value = process.env.ARTIFACT_SIGNING_SECRET?.trim();
  if (!value) throw new Error("Artifact signing is not configured.");
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function safeName(value: string): string {
  return value.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "artifact";
}

export async function registerArtifact(input: {
  ownerId: string;
  conversationId: string;
  name: string;
  contentType: string;
  bytes?: Uint8Array;
  storageObjectId?: string;
  storageKind?: StorageObjectKind;
  documentId?: string;
  messageId?: string;
  projectId?: string;
  revisionId?: string;
  parentRevisionId?: string | null;
  workspacePath?: string;
  language?: string;
  preview?: "html" | "markdown" | "svg" | "image" | "text" | "none";
  origin?: "generated" | "uploaded";
  editable?: boolean;
  sourceCompleteness?: "complete" | "entrypoint-only";
}): Promise<ChatArtifact> {
  const object = input.storageObjectId
    ? await getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId, state: "complete" })
    : input.bytes
      ? await storeStorageObject({
        metadata: {
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          documentId: input.documentId,
          messageId: input.messageId,
          projectId: input.projectId,
          revisionId: input.revisionId,
          kind: input.storageKind ?? "artifact",
          originalFilename: safeName(input.name),
          contentType: input.contentType || "application/octet-stream",
        },
        source: input.bytes,
        maxBytes: 100 * 1024 * 1024,
      })
      : null;
  if (!object) throw new Error("The artifact storage object could not be loaded.");
  const expectedContentType = input.contentType || "application/octet-stream";
  const kindMatches = input.storageKind ? object.kind === input.storageKind : object.kind === "artifact" || object.kind === "document";
  const associationsMatch = (input.documentId === undefined || object.documentId === input.documentId)
    && (input.messageId === undefined || object.messageId === input.messageId)
    && (input.projectId === undefined || object.projectId === input.projectId)
    && (input.revisionId === undefined || object.revisionId === input.revisionId);
  if (object.ownerId !== input.ownerId || object.conversationId !== input.conversationId || !kindMatches || !associationsMatch || object.contentType !== expectedContentType || !isStorageObjectId(object.objectId)) {
    throw new Error("The artifact storage object is not available to this owner.");
  }
  const descriptor: ArtifactDescriptor = {
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    objectId: object.objectId,
    name: safeName(input.name),
    contentType: object.contentType,
    size: object.size,
    sha256: object.sha256 ?? "",
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.preview ? { preview: input.preview } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(input.parentRevisionId !== undefined ? { parentRevisionId: input.parentRevisionId } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.editable !== undefined ? { editable: input.editable } : {}),
    ...(input.sourceCompleteness ? { sourceCompleteness: input.sourceCompleteness } : {}),
  };
  if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) throw new Error("Artifact storage metadata is missing a SHA-256 digest.");
  const payload = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url");
  return {
    id: `${payload}.${signature(payload)}`,
    name: descriptor.name,
    contentType: descriptor.contentType,
    size: descriptor.size,
    ...(descriptor.sha256 ? { sha256: descriptor.sha256 } : {}),
    ...(descriptor.workspacePath ? { workspacePath: descriptor.workspacePath } : {}),
    ...(descriptor.language ? { language: descriptor.language } : {}),
    ...(descriptor.preview ? { preview: descriptor.preview } : {}),
    ...(descriptor.projectId ? { projectId: descriptor.projectId } : {}),
    ...(descriptor.revisionId ? { revisionId: descriptor.revisionId } : {}),
    ...(descriptor.parentRevisionId !== undefined ? { parentRevisionId: descriptor.parentRevisionId } : {}),
    ...(descriptor.origin ? { origin: descriptor.origin } : {}),
    ...(descriptor.editable !== undefined ? { editable: descriptor.editable } : {}),
    ...(descriptor.sourceCompleteness ? { sourceCompleteness: descriptor.sourceCompleteness } : {}),
  };
}

export function readArtifactDescriptor(id: string, ownerId: string): ArtifactDescriptor | null {
  try {
    const separator = id.lastIndexOf(".");
    if (separator <= 0) return null;
    const payload = id.slice(0, separator);
    const suppliedSignature = id.slice(separator + 1);
    const expectedSignature = signature(payload);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ArtifactDescriptor;
    if (
      value.ownerId !== ownerId
      || typeof value.conversationId !== "string"
      || !isStorageObjectId(value.objectId)
      || typeof value.name !== "string"
      || typeof value.contentType !== "string"
      || !Number.isSafeInteger(value.size)
      || value.size < 0
      || !/^[0-9a-f]{64}$/.test(value.sha256)
    ) return null;
    return value;
  } catch {
    return null;
  }
}
