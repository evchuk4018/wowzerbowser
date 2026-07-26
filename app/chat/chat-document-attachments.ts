"use client";
import { DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../lib/chat-document";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming, type DocumentIngestionStage } from "../server/chat/document-ingestion-timing";
export type PendingChatDocument = { id: string; file: File };
export function validateChatDocument(file: File): string | null { if (!DOCUMENT_CONTENT_TYPES.includes(file.type as never) || file.name.toLowerCase().endsWith(".doc")) return "Choose a PDF or DOCX file."; if (file.size > MAX_PDF_BYTES) return "Documents must be 25 MiB or smaller."; return null; }
async function errorFor(response: Response) {
 const body=await response.json().catch(()=>null) as {error?:string;failedStage?:unknown}|null;
 const error=Object.assign(new Error(body?.error ?? `Document upload failed (${response.status}).`), typeof body?.failedStage === "string" ? { failedStage: body.failedStage } : {});
 return error as Error & { failedStage?: DocumentIngestionStage };
}
export async function uploadChatDocument(input: { conversationId:string; userMessageId:string; jobId:string; document:PendingChatDocument; accessToken:string; signal:AbortSignal }): Promise<ChatDocumentAttachment> {
 const timing = new DocumentIngestionTiming({ documentType: input.document.file.type, byteSize: input.document.file.size, cacheStatus: "unknown" });
 const headers={authorization:`Bearer ${input.accessToken}`,"content-type":"application/json"};
 try {
  const signed=await timing.measure(DOCUMENT_INGESTION_STAGES.SIGNED_UPLOAD_URL,async()=>{const response=await fetch("/api/chat/documents/upload-url",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,size:input.document.file.size,contentType:input.document.file.type})}); if(!response.ok)throw await errorFor(response); return await response.json() as {signedUrl:string};});
  await timing.measure(DOCUMENT_INGESTION_STAGES.BROWSER_UPLOAD,async()=>{const response=await fetch(signed.signedUrl,{method:"PUT",headers:{"content-type":input.document.file.type},body:input.document.file,signal:input.signal}); if(!response.ok)throw new Error("Direct document upload failed.");});
  const document=await timing.measure(DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST,async()=>{const response=await fetch("/api/chat/documents/finalize",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,userMessageId:input.userMessageId,jobId:input.jobId,filename:input.document.file.name,contentType:input.document.file.type})}); if(!response.ok)throw await errorFor(response); return (await response.json() as {document:ChatDocumentAttachment}).document;});
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
