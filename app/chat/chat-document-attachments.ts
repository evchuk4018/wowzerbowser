"use client";
import { DOCX_CONTENT_TYPE, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../lib/chat-document";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "../server/chat/document-ingestion-timing";
import { authFetch } from "../auth/auth-fetch";

export type ChatDocumentUploadContext = {
 conversationId: string;
 userMessageId: string;
 jobId: string;
 projectId?: string;
};

export type ChatDocumentPreparationStatus = "uploading" | "parsing" | "ready" | "error" | "cancelled";

export type PendingChatDocument = {
 id: string;
 file: File;
 uploadContext?: ChatDocumentUploadContext;
 preparationPromise?: Promise<ChatDocumentAttachment>;
 abortController?: AbortController;
 preparationStatus?: ChatDocumentPreparationStatus;
 preparationError?: string;
 /** Set once the attachment has been accepted by the durable chat stream. */
 consumed?: boolean;
 /** Internal idempotence guard for removal cleanup. */
 cleanupPromise?: Promise<void>;
};

export function chatDocumentContentType(file: Pick<File, "name" | "type">): ChatDocumentAttachment["contentType"] | null {
 const name = file.name.toLowerCase();
 if (name.endsWith(".doc")) return null;
 if (DOCUMENT_CONTENT_TYPES.includes(file.type as never)) return file.type as ChatDocumentAttachment["contentType"];
 if (name.endsWith(".pdf")) return "application/pdf";
 if (name.endsWith(".docx")) return DOCX_CONTENT_TYPE;
 return null;
}

export function validateChatDocument(file: File): string | null { if (!chatDocumentContentType(file) || file.size > MAX_PDF_BYTES) return !chatDocumentContentType(file) ? "Choose a PDF or DOCX file." : "Documents must be 25 MiB or smaller."; return null; }
async function errorFor(response: Response) {
 const body=await response.json().catch(()=>null) as {error?:string;failedStage?:unknown}|null;
 const error=Object.assign(new Error(body?.error ?? `Document upload failed (${response.status}).`), typeof body?.failedStage === "string" ? { failedStage: body.failedStage } : {});
 return error as Error & { failedStage?: DocumentIngestionStage };
}

async function waitForDocumentJob(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(Object.assign(new Error("Document preparation was cancelled."), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function uploadChatDocument(input: {
 conversationId:string;
 projectId?: string;
 userMessageId:string;
 jobId:string;
 document:PendingChatDocument;
 signal:AbortSignal;
 onStageChange?: (stage: "uploading" | "parsing") => void;
}): Promise<ChatDocumentAttachment> {
 const timing = new DocumentIngestionTiming({ documentType: input.document.file.type, byteSize: input.document.file.size, cacheStatus: "unknown" });
 const contentType = chatDocumentContentType(input.document.file);
 if (!contentType) throw new Error("Choose a PDF or DOCX file.");
 const headers={"content-type":"application/json"};
 try {
  input.onStageChange?.("uploading");
  const uploaded=await timing.measure(DOCUMENT_INGESTION_STAGES.APPLICATION_UPLOAD,async()=>{const response=await authFetch("/api/chat/documents/upload",{method:"POST",headers:{"content-type":contentType,"x-conversation-id":input.conversationId,"x-document-id":input.document.id,"x-file-name":input.document.file.name,...(input.projectId ? {"x-project-id": input.projectId} : {})},signal:input.signal,body:input.document.file}); if(!response.ok)throw await errorFor(response); return await response.json() as {storageObjectId:string};});
  input.onStageChange?.("parsing");
   const queued=await timing.measure(DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST,async()=>{const response=await authFetch("/api/chat/documents/finalize",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,storageObjectId:uploaded.storageObjectId,userMessageId:input.userMessageId,jobId:input.jobId,contentType,filename:input.document.file.name,...(input.projectId ? {projectId: input.projectId} : {})})}); if(!response.ok)throw await errorFor(response); return await response.json() as {processingJobId:string;status:string;document?:ChatDocumentAttachment};});
   let document=queued.document;
   let pollDelay=250;
   while (!document) {
    await waitForDocumentJob(pollDelay, input.signal);
    const response=await authFetch(`/api/chat/documents/jobs/${encodeURIComponent(input.conversationId)}/${encodeURIComponent(queued.processingJobId)}`,{signal:input.signal});
    if(!response.ok)throw await errorFor(response);
    const snapshot=await response.json() as {status:string;error?:string|null;progress?:{stage?:string};document?:ChatDocumentAttachment};
    if(snapshot.status === "completed" && snapshot.document) { document=snapshot.document; break; }
    if(snapshot.status === "failed" || snapshot.status === "cancelled") {
      const error=Object.assign(new Error(snapshot.error ?? "The document could not be processed."), snapshot.progress?.stage ? { failedStage: snapshot.progress.stage } : {});
      throw error;
    }
    pollDelay=Math.min(2000,Math.round(pollDelay*1.5));
   }
   timing.updateMetadata({ pageCount: document.pageCount, ocrPageCount: document.analyzedImageCount ?? 0 });
  timing.finish();
  timing.log((entry)=>console.info(entry));
  return document;
 } catch(error) {
  const failedStage = error && typeof error === "object" && "failedStage" in error && typeof error.failedStage === "string" ? error.failedStage : null;
  if (failedStage && Object.values(DOCUMENT_INGESTION_STAGES).includes(failedStage as DocumentIngestionStage)) timing.markFailed(failedStage as DocumentIngestionStage);
  timing.finish();
  timing.log((entry)=>console.info(entry));
  throw error;
 }
}

export async function deleteChatDocument(input: {
 conversationId: string;
 document: Pick<PendingChatDocument, "id" | "file">;
}): Promise<void> {
 const contentType = chatDocumentContentType(input.document.file);
 if (!contentType) return;
 const response = await authFetch("/api/chat/documents/delete", {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
   conversationId: input.conversationId,
   documentId: input.document.id,
   contentType,
  }),
 });
 if (!response.ok) throw await errorFor(response);
}
