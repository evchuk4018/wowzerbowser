import { after, NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { CHAT_DOCUMENT_BUCKET, ChatDocumentError, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { getServerClient } from "../../../../auth/supabase-server-adapter";
import { documentStoragePath } from "../../../../server/chat/chat-document-store";
import { ingestDocx, ingestPdf } from "../../../../server/chat/chat-document-service";
import { cleanupEmptyChatConversation } from "../../../../server/chat/chat-conversation-service";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming } from "../../../../server/chat/document-ingestion-timing";

export const runtime = "nodejs";
export const maxDuration = 300;

function scheduleCleanup(task: () => Promise<unknown>): void {
 try {
  after(() => task().catch(() => undefined));
 } catch {
  // Route unit tests do not provide a Next request context.
 }
}

function respond(body: unknown, init: ResponseInit, timing: DocumentIngestionTiming) {
 const response = NextResponse.json(body, init); const serverTiming = timing.serverTiming(); if (serverTiming) response.headers.set("Server-Timing", serverTiming); return response;
}

function logTiming(timing: DocumentIngestionTiming) { timing.finish(); timing.log((entry) => console.info(entry)); }

function latestFailedStage(timing: DocumentIngestionTiming): string | null {
 const failed = timing.snapshot().stages.filter((stage) => stage.status === "failed");
 return failed.at(-1)?.stage ?? timing.failedStage;
}

type FinalizeDependencies = {
 authorizeOwnerSession: typeof authorizeOwnerSession;
 getServerClient: typeof getServerClient;
 ingestPdf: typeof ingestPdf;
 ingestDocx: typeof ingestDocx;
 cleanupEmptyChatConversation: typeof cleanupEmptyChatConversation;
};

function publicFailureMessage(stage: string, status?: number) {
 if (status === 413) return "Documents must be 25 MiB or smaller.";
 if (stage === DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD) return "The document could not be downloaded.";
 if (stage === DOCUMENT_INGESTION_STAGES.NATIVE_PARSING) return "The document is not a valid PDF or DOCX file.";
 if (stage === DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING) return "The external PDF parser could not prepare the document.";
 if (stage === DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS) return "The DOCX image analysis did not complete.";
 if (stage === DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION) return "The document could not be registered.";
 return "The document could not be finalized.";
}

export function createFinalizeHandler(overrides: Partial<FinalizeDependencies> = {}) {
 const deps: FinalizeDependencies = { authorizeOwnerSession, getServerClient, ingestPdf, ingestDocx, cleanupEmptyChatConversation, ...overrides };
 return async (request: Request) => {
 const auth=request.headers.get("authorization"); const owner=auth?.startsWith("Bearer ")?await deps.authorizeOwnerSession(auth.slice(7)):null; if(!owner)return NextResponse.json({error:"Unauthorized."},{status:401});
 const body=await request.json().catch(()=>null) as Record<string,unknown>|null; if(!body||typeof body.conversationId!=="string"||typeof body.documentId!=="string"||typeof body.userMessageId!=="string"||typeof body.jobId!=="string"||typeof body.filename!=="string"||!DOCUMENT_CONTENT_TYPES.includes(body.contentType as never))return NextResponse.json({error:"Invalid document metadata."},{status:400});
 const contentType=body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number];
 const timing = new DocumentIngestionTiming({ documentType: contentType, cacheStatus: "bypass" });
 const requestSpan = timing.begin(DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST);
 try {
  const path=documentStoragePath(owner.id,body.conversationId,body.documentId,contentType);
  const source=await timing.measure(DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD,async()=>{const {data,error}=await deps.getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).download(path); if(error)throw error; const bytes=new Uint8Array(await data.arrayBuffer()); if(bytes.length>MAX_PDF_BYTES)throw new ChatDocumentError("document_too_large","Documents must be 25 MiB or smaller.",413); return { bytes };});
  timing.updateMetadata({ byteSize: source.bytes.length });
  const common={ownerId:owner.id,conversationId:body.conversationId,filename:body.filename,bytes:source.bytes,userMessageId:body.userMessageId,jobId:body.jobId,alreadyUploaded:true,timing};
  const document=contentType==="application/pdf"?await deps.ingestPdf({...common,pdfId:body.documentId}):await deps.ingestDocx({...common,documentId:body.documentId});
  timing.updateMetadata({ pageCount: document.pageCount });
  requestSpan.end();
  logTiming(timing);
  return respond({document}, {}, timing);
 } catch(error){
  scheduleCleanup(() => deps.cleanupEmptyChatConversation(owner.id, body.conversationId as string));
  if (timing.failedStage) requestSpan.end(); else requestSpan.fail();
  logTiming(timing);
  const failedStage = latestFailedStage(timing) ?? DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST;
  const status = error instanceof ChatDocumentError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  return respond({error:publicFailureMessage(failedStage,status),failedStage},{status},timing);
 }
}; }
export const POST=createFinalizeHandler();
