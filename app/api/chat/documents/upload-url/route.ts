import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatDocumentError, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { createSignedDocumentUpload } from "../../../../server/chat/chat-document-store";
import { ensureChatDocumentSchema } from "../../../../server/chat/chat-document-schema";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming } from "../../../../server/chat/document-ingestion-timing";

function respond(body: unknown, init: ResponseInit, timing: DocumentIngestionTiming) {
  const response = NextResponse.json(body, init);
  const serverTiming = timing.serverTiming();
  if (serverTiming) response.headers.set("Server-Timing", serverTiming);
  return response;
}

function logTiming(timing: DocumentIngestionTiming) {
  timing.finish();
  timing.log((entry) => console.info(entry));
}

export function createUploadUrlHandler(deps = { authorizeOwnerSession, createSignedDocumentUpload, ensureChatDocumentSchema }) { return async (request: Request) => {
  const owner = await deps.authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.conversationId !== "string" || typeof body.documentId !== "string" || typeof body.size !== "number" || body.size > MAX_PDF_BYTES || body.size < 1 || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)) return NextResponse.json({ error: "Invalid document upload." }, { status: 400 });
  const timing = new DocumentIngestionTiming({ documentType: body.contentType as string, byteSize: body.size, cacheStatus: "unknown" });
  try {
    await deps.ensureChatDocumentSchema();
    const payload = await timing.measure(DOCUMENT_INGESTION_STAGES.SIGNED_UPLOAD_URL, () => deps.createSignedDocumentUpload({ ownerId: owner.id, conversationId: body.conversationId as string, documentId: body.documentId as string, contentType: body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number] }));
    logTiming(timing);
    return respond(payload, {}, timing);
  } catch (error) {
    const schemaFailure = error instanceof ChatDocumentError && error.code === "document_schema_unavailable";
    if (schemaFailure) timing.markFailed(DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION);
    logTiming(timing);
    return respond({ error: schemaFailure ? error.message : "Document storage is unavailable.", code: schemaFailure ? error.code : "document_storage_unavailable", ...(timing.failedStage ? { failedStage: timing.failedStage } : {}) }, { status: 503 }, timing);
  }
}; }
export const POST = createUploadUrlHandler();
