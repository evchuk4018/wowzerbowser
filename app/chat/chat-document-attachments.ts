"use client";
import { DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../lib/chat-document";
export type PendingChatDocument = { id: string; file: File };
export function validateChatDocument(file: File): string | null { if (!DOCUMENT_CONTENT_TYPES.includes(file.type as never) || file.name.toLowerCase().endsWith(".doc")) return "Choose a PDF or DOCX file."; if (file.size > MAX_PDF_BYTES) return "Documents must be 25 MiB or smaller."; return null; }
async function errorFor(response: Response) { const body=await response.json().catch(()=>null) as {error?:string}|null; return body?.error ?? `PDF upload failed (${response.status}).`; }
export async function uploadChatDocument(input: { conversationId:string; userMessageId:string; jobId:string; document:PendingChatDocument; accessToken:string; signal:AbortSignal }): Promise<ChatDocumentAttachment> {
 const headers={authorization:`Bearer ${input.accessToken}`,"content-type":"application/json"};
 const start=await fetch("/api/chat/documents/upload-url",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,size:input.document.file.size,contentType:input.document.file.type})}); if(!start.ok)throw new Error(await errorFor(start));
 const signed=await start.json() as {signedUrl:string}; const upload=await fetch(signed.signedUrl,{method:"PUT",headers:{"content-type":input.document.file.type},body:input.document.file,signal:input.signal}); if(!upload.ok)throw new Error("Direct document upload failed.");
 const finish=await fetch("/api/chat/documents/finalize",{method:"POST",headers,signal:input.signal,body:JSON.stringify({conversationId:input.conversationId,documentId:input.document.id,userMessageId:input.userMessageId,jobId:input.jobId,filename:input.document.file.name,contentType:input.document.file.type})}); if(!finish.ok)throw new Error(await errorFor(finish)); return (await finish.json() as {document:ChatDocumentAttachment}).document;
}
