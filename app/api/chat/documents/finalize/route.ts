import { after, NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatDocumentError, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { isStorageObjectId } from "../../../../../lib/storage-protocol";
import { readPendingDocumentUpload } from "../../../../server/chat/chat-document-store";
import { ensureChatDocumentSchema } from "../../../../server/chat/chat-document-schema";
import { ingestDocx, ingestPdf } from "../../../../server/chat/chat-document-service";
import { cleanupEmptyChatConversation } from "../../../../server/chat/chat-conversation-service";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming } from "../../../../server/chat/document-ingestion-timing";

export const runtime = "nodejs";
export const maxDuration = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function scheduleCleanup(task: () => Promise<unknown>): void {
  try { after(() => task().catch(() => undefined)); } catch {}
}

function respond(body: unknown, init: ResponseInit, timing: DocumentIngestionTiming) {
  const response = NextResponse.json(body, init);
  const serverTiming = timing.serverTiming();
  if (serverTiming) response.headers.set("Server-Timing", serverTiming);
  return response;
}

function logTiming(timing: DocumentIngestionTiming) { timing.finish(); timing.log((entry) => console.info(entry)); }

function latestFailedStage(timing: DocumentIngestionTiming): string | null {
  const failed = timing.snapshot().stages.filter((stage) => stage.status === "failed");
  return failed.at(-1)?.stage ?? timing.failedStage;
}

function publicFailureMessage(stage: string, status?: number) {
  if (status === 413) return "Documents must be 25 MiB or smaller.";
  if (stage === DOCUMENT_INGESTION_STAGES.STORAGE_READ) return "The document could not be read.";
  if (stage === DOCUMENT_INGESTION_STAGES.NATIVE_PARSING) return "The document is not a valid PDF or DOCX file.";
  if (stage === DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING) return "The external PDF parser could not prepare the document.";
  if (stage === DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS) return "The DOCX image analysis did not complete.";
  if (stage === DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION) return "The document could not be registered.";
  return "The document could not be finalized.";
}

export function createFinalizeHandler(dependencies = {
  authorizeOwnerSession,
  readPendingDocumentUpload,
  ensureChatDocumentSchema,
  ingestPdf,
  ingestDocx,
  cleanupEmptyChatConversation,
}) {
  return async function POST(request: Request) {
  const owner = await dependencies.authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.conversationId !== "string" || !ID_PATTERN.test(body.conversationId) || typeof body.documentId !== "string" || !ID_PATTERN.test(body.documentId) || typeof body.storageObjectId !== "string" || !isStorageObjectId(body.storageObjectId) || typeof body.userMessageId !== "string" || !ID_PATTERN.test(body.userMessageId) || typeof body.jobId !== "string" || !ID_PATTERN.test(body.jobId) || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)) {
    return NextResponse.json({ error: "Invalid document metadata." }, { status: 400 });
  }
  const contentType = body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number];
  const timing = new DocumentIngestionTiming({ documentType: contentType, cacheStatus: "bypass" });
  const requestSpan = timing.begin(DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST);
  try {
    await dependencies.ensureChatDocumentSchema();
    const source = await timing.measure(DOCUMENT_INGESTION_STAGES.STORAGE_READ, () => dependencies.readPendingDocumentUpload({ ownerId: owner.id, conversationId: body.conversationId as string, documentId: body.documentId as string, storageObjectId: body.storageObjectId as string, contentType }));
    if (source.bytes.byteLength > MAX_PDF_BYTES) throw new ChatDocumentError("document_too_large", "Documents must be 25 MiB or smaller.", 413);
    timing.updateMetadata({ byteSize: source.bytes.byteLength });
    const common = { ownerId: owner.id, conversationId: body.conversationId as string, filename: source.object.originalFilename ?? "document", bytes: source.bytes, userMessageId: body.userMessageId as string, jobId: body.jobId as string, alreadyUploaded: true, storageObjectId: source.object.objectId, timing };
    const document = contentType === "application/pdf" ? await dependencies.ingestPdf({ ...common, pdfId: body.documentId as string }) : await dependencies.ingestDocx({ ...common, documentId: body.documentId as string });
    timing.updateMetadata({ pageCount: document.pageCount });
    requestSpan.end();
    logTiming(timing);
    return respond({ document }, {}, timing);
  } catch (error) {
    scheduleCleanup(() => dependencies.cleanupEmptyChatConversation(owner.id, body.conversationId as string));
    if (timing.failedStage) requestSpan.end(); else requestSpan.fail();
    logTiming(timing);
    const failedStage = latestFailedStage(timing) ?? DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST;
    const status = error instanceof ChatDocumentError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    return respond({ error: publicFailureMessage(failedStage, status), failedStage }, { status }, timing);
  }
  };
}

export const POST = createFinalizeHandler();
