import "server-only";
import { CHAT_DOCUMENT_BUCKET, type ChatDocumentAttachment, type ChatDocumentPage } from "../../../lib/chat-document";
import { getServerClient } from "../../auth/supabase-server-adapter";

export const documentStoragePath = (ownerId: string, conversationId: string, pdfId: string) => `${ownerId}/${conversationId}/${pdfId}.pdf`;

export async function createSignedDocumentUpload(input: { ownerId: string; conversationId: string; pdfId: string }) {
  const path = documentStoragePath(input.ownerId, input.conversationId, input.pdfId);
  const { data, error } = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token, signedUrl: data.signedUrl };
}

export async function registerDocument(input: { ownerId: string; conversationId: string; userMessageId: string | null; jobId: string | null; document: ChatDocumentAttachment; pages: ChatDocumentPage[] }) {
  const db = getServerClient();
  const { error } = await db.from("chat_documents").insert({ owner_id: input.ownerId, conversation_id: input.conversationId, document_id: input.document.id, user_message_id: input.userMessageId, job_id: input.jobId, storage_path: documentStoragePath(input.ownerId, input.conversationId, input.document.id), filename: input.document.name, content_type: "application/pdf", size: input.document.size, page_count: input.document.pageCount, token_estimate: input.document.tokenEstimate, status: "complete" });
  if (error) throw error;
  const { error: pageError } = await db.from("chat_document_pages").insert(input.pages.map((page) => ({ owner_id: input.ownerId, conversation_id: input.conversationId, document_id: input.document.id, page_number: page.pageNumber, text: page.text })));
  if (pageError) throw pageError;
}

export async function getAuthorizedDocument(ownerId: string, conversationId: string, pdfId: string): Promise<ChatDocumentAttachment | null> {
  const { data, error } = await getServerClient().from("chat_documents").select("document_id,filename,content_type,size,page_count,token_estimate").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("document_id", pdfId).eq("status", "complete").maybeSingle();
  if (error) throw error; if (!data) return null;
  return { id: data.document_id, name: data.filename, contentType: "application/pdf", size: Number(data.size), pageCount: Number(data.page_count), tokenEstimate: Number(data.token_estimate) };
}

export async function getDocumentPages(ownerId: string, conversationId: string, pdfId: string, start = 1, end = 100000): Promise<ChatDocumentPage[]> {
  const { data, error } = await getServerClient().from("chat_document_pages").select("page_number,text").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("document_id", pdfId).gte("page_number", start).lte("page_number", end).order("page_number");
  if (error) throw error; return (data ?? []).map((p) => ({ pageNumber: Number(p.page_number), text: p.text }));
}

export async function uploadDocumentBytes(path: string, bytes: Uint8Array) {
  const { error } = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false }); if (error) throw error;
}
