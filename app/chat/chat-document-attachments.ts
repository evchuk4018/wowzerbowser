"use client";
import { DOCX_CONTENT_TYPE, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../lib/chat-document";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "../server/chat/document-ingestion-timing";

export type ChatDocumentUploadContext = {
 conversationId: string;
 userMessageId: string;
 jobId: string;
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

export async function uploadChatDocument(input: {
 conversationId:string;
 userMessageId:string;
 jobId:string;
 document:PendingChatDocument;
 accessToken:string;
 signal:AbortSignal;
 onStageChange?: (stage: "uploading" | "parsing") => void;
}): Promise<ChatDocumentAttachment> {
 const timing = new DocumentIngestionTiming({ documentType: input.document.file.type, byteSize: input.document.file.size, cacheStatus: "unknown" });
 const contentType = chatDocumentContentType(input.document.file);
 if (!contentType) throw new Error("Choose a PDF or DOCX file.");
 const headers={authorization:`Bearer ${input.accessToken}`,"content-type":"application/json"};
 try {
  input.onStageChange?.("uploading");
  const signed=await timing.measure(DOCUMENT_INGESTION_STAGES.SIGNED_UPLOAD_URL,async()=>{const response=await fetch("/api/chat/documents/upload-url",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,size:input.document.file.size,contentType})}); if(!response.ok)throw await errorFor(response); return await response.json() as {signedUrl:string};});
  await timing.measure(DOCUMENT_INGESTION_STAGES.BROWSER_UPLOAD,async()=>{const response=await fetch(signed.signedUrl,{method:"PUT",headers:{"content-type":contentType},body:input.document.file,signal:input.signal}); if(!response.ok)throw new Error("Direct document upload failed.");});
  input.onStageChange?.("parsing");
  const document=await timing.measure(DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST,async()=>{const response=await fetch("/api/chat/documents/finalize",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,userMessageId:input.userMessageId,jobId:input.jobId,filename:input.document.file.name,contentType})}); if(!response.ok)throw await errorFor(response); return (await response.json() as {document:ChatDocumentAttachment}).document;});
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
 accessToken: string;
}): Promise<void> {
 const contentType = chatDocumentContentType(input.document.file);
 if (!contentType) return;
 const response = await fetch("/api/chat/documents/delete", {
  method: "DELETE",
  headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({
   conversationId: input.conversationId,
   documentId: input.document.id,
   contentType,
  }),
 });
 if (!response.ok) throw await errorFor(response);
}
