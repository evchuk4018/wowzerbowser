import "server-only";
import { CHAT_DOCUMENT_BUCKET, DOCX_CONTENT_TYPE, ChatDocumentError, PDF_PAGE_EXTRACTION_METHODS, type ChatDocumentAttachment, type ChatDocumentPage, type ChatDocumentPageFailure } from "../../../lib/chat-document";
import { getServerClient } from "../storage/supabase-storage-adapter";
import { databaseOwnerId, jsonb, query } from "../database/database";
import { DOCUMENT_INGESTION_STAGES, type DocumentIngestionTiming } from "./document-ingestion-timing";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

export const CHAT_DOCUMENT_DOWNLOAD_URL_EXPIRATION_SECONDS = 60;

export async function assertChatDocumentTables(): Promise<void> {
  await Promise.all([
    query(`select has_images,image_count,analyzed_image_count,image_analyses from chat_documents limit 0`),
    query(`select extraction_method,failure from chat_document_pages limit 0`),
    query(`select documents from chat_messages limit 0`),
  ]);
}

function storedPageFailure(value: unknown): ChatDocumentPageFailure | undefined {
  if (!value || typeof value !== "object" || !("code" in value) || !("message" in value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const attempts = "attempts" in value ? value.attempts : undefined;
  return {
    code: value.code.slice(0, 80),
    message: value.message.slice(0, 300),
    ...(typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts >= 0 ? { attempts } : {}),
  };
}

function storedPageMethod(value: unknown, text: unknown): ChatDocumentPage["extractionMethod"] {
  if (typeof value === "string" && PDF_PAGE_EXTRACTION_METHODS.includes(value as ChatDocumentPage["extractionMethod"])) return value as ChatDocumentPage["extractionMethod"];
  return typeof text === "string" && text.trim() ? "native" : "blank";
}

function configuredSupabaseOrigin(): string | null {
  const configuredUrl = process.env.SUPABASE_URL?.trim();
  if (!configuredUrl) return null;
  try { return new URL(configuredUrl).origin; } catch { return null; }
}

export const documentStoragePath = (ownerId: string, conversationId: string, documentId: string, contentType: ChatDocumentAttachment["contentType"]) => `${ownerId}/${conversationId}/${documentId}.${contentType === DOCX_CONTENT_TYPE ? "docx" : "pdf"}`;

export async function createSignedDocumentUpload(input: { ownerId: string; conversationId: string; documentId: string; contentType: ChatDocumentAttachment["contentType"] }) {
  const path = documentStoragePath(input.ownerId, input.conversationId, input.documentId, input.contentType);
  const { data, error } = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token, signedUrl: data.signedUrl };
}

function validateSignedDocumentDownloadUrl(signedUrl: string, path: string): string {
  try {
    const url = new URL(signedUrl);
    const pathname = decodeURIComponent(url.pathname);
    const expectedPath = `/storage/v1/object/sign/${CHAT_DOCUMENT_BUCKET}/${path}`;
    const expectedOrigin = configuredSupabaseOrigin();
    if (url.protocol !== "https:" || (expectedOrigin && url.origin !== expectedOrigin) || url.username || url.password || url.hash || !url.searchParams.has("token") || pathname !== expectedPath) throw new Error();
    return signedUrl;
  } catch {
    throw new ChatDocumentError("document_storage_invalid_url", "The document download URL is invalid.", 502);
  }
}

export function assertSignedDocumentDownloadUrl(input: { ownerId: string; conversationId: string; documentId: string; contentType: ChatDocumentAttachment["contentType"]; signedUrl: string }): string {
  return validateSignedDocumentDownloadUrl(input.signedUrl, documentStoragePath(input.ownerId, input.conversationId, input.documentId, input.contentType));
}

export async function createSignedDocumentDownloadUrl(
  input: { ownerId: string; conversationId: string; documentId: string; contentType: ChatDocumentAttachment["contentType"] },
  db: ReturnType<typeof getServerClient> = getServerClient(),
): Promise<string> {
  const path = documentStoragePath(input.ownerId, input.conversationId, input.documentId, input.contentType);
  const { data, error } = await db.storage.from(CHAT_DOCUMENT_BUCKET).createSignedUrl(path, CHAT_DOCUMENT_DOWNLOAD_URL_EXPIRATION_SECONDS);
  if (error) throw error;
  if (!data || typeof data.signedUrl !== "string") throw new ChatDocumentError("document_storage_invalid_url", "The document download URL is invalid.", 502);
  return assertSignedDocumentDownloadUrl({ ...input, signedUrl: data.signedUrl });
}

export async function registerDocument(input: { ownerId: string; conversationId: string; userMessageId: string | null; jobId: string | null; document: ChatDocumentAttachment; pages: ChatDocumentPage[]; timing?: DocumentIngestionTiming }) {
  const register = async () => {
    await withChatPersistenceRetry(async () => {
      await query(
        "select register_chat_document($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7) as result",
        [databaseOwnerId(input.ownerId), input.conversationId, jsonb(input.document), input.userMessageId, input.jobId, jsonb(input.pages), documentStoragePath(input.ownerId, input.conversationId, input.document.id, input.document.contentType)],
      );
    });
  };
  if (input.timing) await input.timing.measure(DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION, register);
  else await register();
}

export async function getAuthorizedDocument(ownerId: string, conversationId: string, pdfId: string): Promise<ChatDocumentAttachment | null> {
  const [data] = await query<Record<string, unknown>>("select document_id,filename,content_type,size,page_count,token_estimate,has_images,image_count,analyzed_image_count,image_analyses,project_id,revision_id,parent_revision_id,origin,editable,source_completeness from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3 and status='complete'", [databaseOwnerId(ownerId), conversationId, pdfId]);
  if (!data) return null;
  return { id: String(data.document_id), name: String(data.filename), contentType: data.content_type as ChatDocumentAttachment["contentType"], size: Number(data.size), pageCount: Number(data.page_count), tokenEstimate: Number(data.token_estimate), hasImages: Boolean(data.has_images), imageCount: Number(data.image_count ?? 0), analyzedImageCount: Number(data.analyzed_image_count ?? 0), imageAnalyses: Array.isArray(data.image_analyses) ? data.image_analyses : [], ...(data.project_id ? { projectId: String(data.project_id), revisionId: typeof data.revision_id === "string" ? data.revision_id : undefined, parentRevisionId: typeof data.parent_revision_id === "string" ? data.parent_revision_id : null, origin: data.origin as ChatDocumentAttachment["origin"], editable: Boolean(data.editable), sourceCompleteness: data.source_completeness as ChatDocumentAttachment["sourceCompleteness"] } : {}) };
}

export async function downloadAuthorizedDocumentBytes(ownerId: string, conversationId: string, documentId: string): Promise<Uint8Array | null> {
  const [data] = await query<{ storage_path: string; content_type: string }>("select storage_path,content_type from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3 and status='complete'", [databaseOwnerId(ownerId), conversationId, documentId]);
  if (!data?.storage_path) return null;
  const result = await getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).download(data.storage_path);
  if (result.error) throw result.error;
  return new Uint8Array(await result.data.arrayBuffer());
}

export async function getDocumentPages(ownerId: string, conversationId: string, pdfId: string, start = 1, end = 100000): Promise<ChatDocumentPage[]> {
  const data = await query<{ page_number: number; text: string; extraction_method: unknown; failure: unknown }>("select page_number,text,extraction_method,failure from chat_document_pages where owner_id=$1 and conversation_id=$2 and document_id=$3 and page_number >= $4 and page_number <= $5 order by page_number", [databaseOwnerId(ownerId), conversationId, pdfId, start, end]);
  return data.map((p) => ({ pageNumber: Number(p.page_number), text: p.text, extractionMethod: storedPageMethod(p.extraction_method, p.text), ...(storedPageFailure(p.failure) ? { failure: storedPageFailure(p.failure) } : {}) }));
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
  const [metadata] = await query<{ content_type: string }>("select content_type from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3", [databaseOwnerId(input.ownerId), input.conversationId, input.documentId]);
  const contentType = metadata?.content_type === DOCX_CONTENT_TYPE ? DOCX_CONTENT_TYPE : input.contentType;
  const path = documentStoragePath(input.ownerId, input.conversationId, input.documentId, contentType);
  const { error: storageError } = await db.storage.from(CHAT_DOCUMENT_BUCKET).remove([path]);
  let metadataError: unknown = null;
  try {
    await query("delete from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3", [databaseOwnerId(input.ownerId), input.conversationId, input.documentId]);
  } catch (error) {
    metadataError = error;
  }

  // Metadata cleanup must still happen if an already-removed object caused the
  // storage call to fail. Surface the storage failure after the database work
  // so callers can retry cleanup without leaving a registered document behind.
  if (metadataError) throw metadataError;
  if (storageError) throw storageError;
}

/** Remove registered document objects before their conversation row cascades. */
export async function deleteChatDocumentsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const db = getServerClient();
  const data = await query<{ storage_path: string }>("select storage_path from chat_documents where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
  const paths = (data ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error: storageError } = await db.storage.from(CHAT_DOCUMENT_BUCKET).remove(paths.slice(offset, offset + 100));
    if (storageError) throw storageError;
  }
}
