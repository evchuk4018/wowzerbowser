import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatDocumentError, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { createDocumentStorageUpload, ensureChatDocumentConversation } from "../../../../server/chat/chat-document-store";
import { ensureChatDocumentSchema } from "../../../../server/chat/chat-document-schema";
import { deleteOwnedStorageObject, writePendingStorageObject } from "../../../../server/storage/storage-service";

export const runtime = "nodejs";
export const maxDuration = 120;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeFilename(value: string | null): string {
  const normalized = (value ?? "document").normalize("NFKC").replace(/[\\/\0\r\n]+/g, "-").replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 512);
  return normalized || "document";
}

function contentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value.trim())) throw new ChatDocumentError("invalid_upload", "The document upload size is invalid.", 400);
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "Documents must be 25 MiB or smaller.", 413);
  return size;
}

export function createUploadHandler(dependencies = {
  authorizeOwnerSession,
  ensureChatDocumentSchema,
  ensureChatDocumentConversation,
  createDocumentStorageUpload,
  writePendingStorageObject,
  deleteOwnedStorageObject,
}) {
  return async function POST(request: Request) {
  const owner = await dependencies.authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const conversationId = request.headers.get("x-conversation-id")?.trim() ?? "";
  const documentId = request.headers.get("x-document-id")?.trim() ?? "";
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(documentId) || !DOCUMENT_CONTENT_TYPES.includes(contentType as never) || !request.body) {
    return NextResponse.json({ error: "Invalid document upload." }, { status: 400 });
  }

  try {
    const declaredSize = contentLength(request);
    await dependencies.ensureChatDocumentSchema();
    await dependencies.ensureChatDocumentConversation(owner.id, conversationId);
    const pending = await dependencies.createDocumentStorageUpload({ ownerId: owner.id, conversationId, documentId, filename: safeFilename(request.headers.get("x-file-name")), contentType: contentType as (typeof DOCUMENT_CONTENT_TYPES)[number] });
    const stored = await dependencies.writePendingStorageObject({ ownerId: owner.id, object: pending, source: request.body, maxBytes: MAX_PDF_BYTES });
    if (declaredSize !== null && declaredSize !== stored.size) {
      await dependencies.deleteOwnedStorageObject({ ownerId: owner.id, objectId: stored.objectId }).catch(() => undefined);
      return NextResponse.json({ error: "The document upload size changed during transfer." }, { status: 409 });
    }
    if (stored.size < 1) {
      await dependencies.deleteOwnedStorageObject({ ownerId: owner.id, objectId: stored.objectId }).catch(() => undefined);
      return NextResponse.json({ error: "The document upload is empty." }, { status: 400 });
    }
    return NextResponse.json({ storageObjectId: stored.objectId, size: stored.size, contentType: stored.contentType });
  } catch (error) {
    const status = error instanceof ChatDocumentError ? error.status : 503;
    return NextResponse.json({ error: error instanceof ChatDocumentError ? error.message : "The document could not be uploaded." }, { status });
  }
  };
}

export const POST = createUploadHandler();
