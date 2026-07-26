import "server-only";
import { CHAT_DOCUMENT_BUCKET, DOCX_CONTENT_TYPE, type ChatDocumentAttachment, type ChatDocumentPage } from "../../../lib/chat-document";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { DOCUMENT_INGESTION_STAGES, type DocumentIngestionTiming } from "./document-ingestion-timing";

export const documentStoragePath = (ownerId: string, conversationId: string, documentId: string, contentType: ChatDocumentAttachment["contentType"]) => `${ownerId}/${conversationId}/${documentId}.${contentType === DOCX_CONTENT_TYPE ? "docx" : "pdf"}`;

export async function createSignedDocumentUpload(input: { ownerId: string; conversationId: string; documentId: string; contentType: ChatDocumentAttachment["contentType"] }) {
  const path = documentStoragePath(input.ownerId, input.conversationId, input.documentId, input.contentType);
  const { data, error } = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token, signedUrl: data.signedUrl };
}

export async function registerDocument(input: { ownerId: string; conversationId: string; userMessageId: string | null; jobId: string | null; document: ChatDocumentAttachment; pages: ChatDocumentPage[]; timing?: DocumentIngestionTiming }) {
  const register = async () => {
    const db = getServerClient();
    const { error: conversationError } = await db.from("chat_conversations").upsert({
      owner_id: input.ownerId,
      conversation_id: input.conversationId,
      title: "New conversation",
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id,conversation_id", ignoreDuplicates: true });
    if (conversationError) throw conversationError;
    const { error } = await db.from("chat_documents").insert({ owner_id: input.ownerId, conversation_id: input.conversationId, document_id: input.document.id, user_message_id: input.userMessageId, job_id: input.jobId, storage_path: documentStoragePath(input.ownerId, input.conversationId, input.document.id, input.document.contentType), filename: input.document.name, content_type: input.document.contentType, size: input.document.size, page_count: input.document.pageCount, token_estimate: input.document.tokenEstimate, has_images: input.document.hasImages, image_count: input.document.imageCount, analyzed_image_count: input.document.analyzedImageCount, image_analyses: input.document.imageAnalyses, status: "complete" });
    if (error) throw error;
    const { error: pageError } = await db.from("chat_document_pages").insert(input.pages.map((page) => ({ owner_id: input.ownerId, conversation_id: input.conversationId, document_id: input.document.id, page_number: page.pageNumber, text: page.text })));
    if (pageError) throw pageError;
  };
  if (input.timing) await input.timing.measure(DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION, register);
  else await register();
}

export async function getAuthorizedDocument(ownerId: string, conversationId: string, pdfId: string): Promise<ChatDocumentAttachment | null> {
  const { data, error } = await getServerClient().from("chat_documents").select("document_id,filename,content_type,size,page_count,token_estimate,has_images,image_count,analyzed_image_count,image_analyses").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("document_id", pdfId).eq("status", "complete").maybeSingle();
  if (error) throw error; if (!data) return null;
  return { id: data.document_id, name: data.filename, contentType: data.content_type as ChatDocumentAttachment["contentType"], size: Number(data.size), pageCount: Number(data.page_count), tokenEstimate: Number(data.token_estimate), hasImages: Boolean(data.has_images), imageCount: Number(data.image_count ?? 0), analyzedImageCount: Number(data.analyzed_image_count ?? 0), imageAnalyses: Array.isArray(data.image_analyses) ? data.image_analyses : [] };
}

export async function getDocumentPages(ownerId: string, conversationId: string, pdfId: string, start = 1, end = 100000): Promise<ChatDocumentPage[]> {
  const { data, error } = await getServerClient().from("chat_document_pages").select("page_number,text").eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("document_id", pdfId).gte("page_number", start).lte("page_number", end).order("page_number");
  if (error) throw error; return (data ?? []).map((p) => ({ pageNumber: Number(p.page_number), text: p.text }));
}

export async function uploadDocumentBytes(path: string, bytes: Uint8Array, contentType: ChatDocumentAttachment["contentType"]) {
  const { error } = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).upload(path, bytes, { contentType, upsert: false }); if (error) throw error;
}

export async function deleteDocument(input: {
  ownerId: string;
  conversationId: string;
  documentId: string;
  contentType: ChatDocumentAttachment["contentType"];
}) {
  const db = getServerClient();
  const { data: metadata, error: lookupError } = await db
    .from("chat_documents")
    .select("content_type")
    .eq("owner_id", input.ownerId)
    .eq("conversation_id", input.conversationId)
    .eq("document_id", input.documentId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  const contentType = metadata?.content_type === DOCX_CONTENT_TYPE ? DOCX_CONTENT_TYPE : input.contentType;
  const path = documentStoragePath(input.ownerId, input.conversationId, input.documentId, contentType);
  const { error: storageError } = await db.storage.from(CHAT_DOCUMENT_BUCKET).remove([path]);
  const { error: metadataError } = await db
    .from("chat_documents")
    .delete()
    .eq("owner_id", input.ownerId)
    .eq("conversation_id", input.conversationId)
    .eq("document_id", input.documentId);

  // Metadata cleanup must still happen if an already-removed object caused the
  // storage call to fail. Surface the storage failure after the database work
  // so callers can retry cleanup without leaving a registered document behind.
  if (metadataError) throw metadataError;
  if (storageError) throw storageError;
}
