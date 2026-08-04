import "server-only";

import { ChatDocumentError, PDF_PAGE_EXTRACTION_METHODS, type ChatDocumentAttachment, type ChatDocumentImage, type ChatDocumentPage, type ChatDocumentPageFailure, type ChatDocumentProviderMetadata } from "../../../lib/chat-document";
import type { StorageObject } from "../../../lib/storage-protocol";
import { databaseOwnerId, jsonb, query } from "../database/database";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import { attachStorageObject, createStorageObject, getStorageObjectById } from "../storage/storage-repository";
import { deleteOwnedStorageObject, storeStorageObject } from "../storage/storage-service";
import { DOCUMENT_INGESTION_STAGES, type DocumentIngestionTiming } from "./document-ingestion-timing";
import { withChatPersistenceRetry } from "./chat-persistence-retry";

export async function assertChatDocumentTables(): Promise<void> {
  await Promise.all([
    query("select has_images,image_count,analyzed_image_count,image_analyses,provider_metadata from chat_documents limit 0"),
    query("select extraction_method,failure,markdown,provider_metadata from chat_document_pages limit 0"),
    query("select image_id,page_number,storage_object_id,storage_path,content_type,provider_metadata from chat_document_images limit 0"),
    query("select documents from chat_messages limit 0"),
    query("select object_id from app_storage_objects limit 0"),
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

function storedProviderMetadata(value: unknown): ChatDocumentProviderMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ChatDocumentProviderMetadata;
}

function storedDocumentImage(row: Record<string, unknown>): ChatDocumentImage {
  return {
    imageId: String(row.image_id),
    pageNumber: Number(row.page_number),
    ...(row.storage_object_id ? { storageObjectId: String(row.storage_object_id) } : {}),
    ...(typeof row.storage_path === "string" ? { storagePath: row.storage_path } : {}),
    ...(typeof row.content_type === "string" ? { contentType: row.content_type } : {}),
    ...(storedProviderMetadata(row.provider_metadata) ? { providerMetadata: storedProviderMetadata(row.provider_metadata) } : {}),
  };
}

export function documentStoragePath(objectKey: string): string {
  return objectKey;
}

export async function createDocumentStorageUpload(input: {
  ownerId: string;
  conversationId: string;
  documentId: string;
  filename: string;
  contentType: ChatDocumentAttachment["contentType"];
}): Promise<StorageObject> {
  return createStorageObject({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    documentId: input.documentId,
    kind: "document",
    originalFilename: input.filename,
    contentType: input.contentType,
  });
}

export async function ensureChatDocumentConversation(ownerId: string, conversationId: string): Promise<void> {
  await query("insert into chat_conversations(owner_id,conversation_id,title) values($1,$2,'New conversation') on conflict(owner_id,conversation_id) do nothing", [databaseOwnerId(ownerId), conversationId]);
}

export async function readPendingDocumentUpload(input: { ownerId: string; conversationId: string; documentId: string; storageObjectId: string; contentType: ChatDocumentAttachment["contentType"] }): Promise<{ object: StorageObject; bytes: Uint8Array }> {
  const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId, state: "complete" });
  if (!object || object.kind !== "document" || object.documentId !== input.documentId || object.contentType !== input.contentType) throw new ChatDocumentError("document_storage_invalid", "The uploaded document object is invalid.", 409);
  const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
  if (bytes.byteLength !== object.size) throw new ChatDocumentError("document_storage_changed", "The document has changed since it was uploaded.", 409);
  return { object, bytes };
}

export async function registerDocument(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string | null;
  jobId: string | null;
  document: ChatDocumentAttachment;
  pages: ChatDocumentPage[];
  images?: ChatDocumentImage[];
  storageObjectId: string;
  timing?: DocumentIngestionTiming;
}) {
  const register = async () => {
    const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.storageObjectId, conversationId: input.conversationId, state: "complete" });
    if (!object || object.kind !== "document" || (object.documentId !== null && object.documentId !== input.document.id) || object.contentType !== input.document.contentType || object.size !== input.document.size) {
      throw new ChatDocumentError("document_storage_invalid", "The document storage object is invalid.", 409);
    }
    const pageImages = input.pages.flatMap((page) => page.images ?? []);
    const images = input.images ?? pageImages;
    const document = images.length ? { ...input.document, images } : input.images ? { ...input.document, images: [] } : input.document;
    await withChatPersistenceRetry(async () => {
      await query(
        "select register_chat_document($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7) as result",
        [databaseOwnerId(input.ownerId), input.conversationId, jsonb(document), input.userMessageId, input.jobId, jsonb(input.pages), documentStoragePath(object.objectKey)],
      );
      await query("update chat_documents set storage_object_id=$1::uuid where owner_id=$2 and conversation_id=$3 and document_id=$4", [object.objectId, databaseOwnerId(input.ownerId), input.conversationId, input.document.id]);
    });
    await attachStorageObject({ ownerId: input.ownerId, objectId: object.objectId, conversationId: input.conversationId, documentId: input.document.id, kind: "document", messageId: input.userMessageId });
  };
  if (input.timing) await input.timing.measure(DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION, register);
  else await register();
}

export async function getAuthorizedDocument(ownerId: string, conversationId: string, pdfId: string): Promise<ChatDocumentAttachment | null> {
  const [data] = await query<Record<string, unknown>>("select document_id,filename,content_type,size,page_count,token_estimate,has_images,image_count,analyzed_image_count,image_analyses,provider_metadata,project_id,revision_id,parent_revision_id,origin,editable,source_completeness from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3 and status='complete'", [databaseOwnerId(ownerId), conversationId, pdfId]);
  if (!data) return null;
  const images = await getAuthorizedDocumentImages(ownerId, conversationId, pdfId);
  return {
    id: String(data.document_id),
    name: String(data.filename),
    contentType: data.content_type as ChatDocumentAttachment["contentType"],
    size: Number(data.size),
    pageCount: Number(data.page_count),
    tokenEstimate: Number(data.token_estimate),
    hasImages: Boolean(data.has_images),
    imageCount: Number(data.image_count ?? 0),
    analyzedImageCount: Number(data.analyzed_image_count ?? 0),
    imageAnalyses: Array.isArray(data.image_analyses) ? data.image_analyses : [],
    ...(storedProviderMetadata(data.provider_metadata) ? { providerMetadata: storedProviderMetadata(data.provider_metadata) } : {}),
    ...(images.length ? { images } : {}),
    ...(data.project_id ? { projectId: String(data.project_id), revisionId: typeof data.revision_id === "string" ? data.revision_id : undefined, parentRevisionId: typeof data.parent_revision_id === "string" ? data.parent_revision_id : null, origin: data.origin as ChatDocumentAttachment["origin"], editable: Boolean(data.editable), sourceCompleteness: data.source_completeness as ChatDocumentAttachment["sourceCompleteness"] } : {}),
  };
}

export async function getAuthorizedDocumentImages(ownerId: string, conversationId: string, documentId: string): Promise<ChatDocumentImage[]> {
  const rows = await query<Record<string, unknown>>(
    `select images.image_id,images.page_number,images.storage_object_id,images.storage_path,
            images.content_type,images.provider_metadata
       from chat_document_images images
       join chat_documents documents
         on documents.owner_id=images.owner_id
        and documents.conversation_id=images.conversation_id
        and documents.document_id=images.document_id
      where images.owner_id=$1 and images.conversation_id=$2 and images.document_id=$3
        and documents.status='complete'
      order by images.page_number,images.image_id`,
    [databaseOwnerId(ownerId), conversationId, documentId],
  );
  return rows.map(storedDocumentImage);
}

export async function getAuthorizedDocumentImage(ownerId: string, conversationId: string, documentId: string, imageId: string): Promise<ChatDocumentImage | null> {
  const images = await getAuthorizedDocumentImages(ownerId, conversationId, documentId);
  return images.find((image) => image.imageId === imageId) ?? null;
}

export async function openAuthorizedDocumentImage(ownerId: string, conversationId: string, documentId: string, imageId: string): Promise<{ object: StorageObject; stream: ReadableStream<Uint8Array>; size: number } | null> {
  const image = await getAuthorizedDocumentImage(ownerId, conversationId, documentId, imageId);
  if (!image?.storageObjectId || !image.storagePath || !image.contentType) return null;
  const object = await getStorageObjectById({ ownerId, objectId: image.storageObjectId, conversationId, state: "complete" });
  if (!object || object.kind !== "document-image" || object.documentId !== documentId || object.objectKey !== image.storagePath || object.contentType !== image.contentType) return null;
  const opened = await localFilesystemStorageProvider.readObject(object);
  if (opened.size !== object.size) throw new ChatDocumentError("document_storage_changed", "The document image has changed since it was stored.", 409);
  return { object, ...opened };
}

export async function getAuthorizedDocumentStorageObject(ownerId: string, conversationId: string, documentId: string): Promise<StorageObject | null> {
  const [row] = await query<{ storage_object_id: string | null; content_type: string }>("select storage_object_id,content_type from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3 and status='complete'", [databaseOwnerId(ownerId), conversationId, documentId]);
  if (!row?.storage_object_id) return null;
  const object = await getStorageObjectById({ ownerId, objectId: row.storage_object_id, conversationId, state: "complete" });
  if (!object || object.kind !== "document" || object.documentId !== documentId || object.contentType !== row.content_type) return null;
  return object;
}

export async function openAuthorizedDocument(ownerId: string, conversationId: string, documentId: string): Promise<{ object: StorageObject; stream: ReadableStream<Uint8Array>; size: number } | null> {
  const object = await getAuthorizedDocumentStorageObject(ownerId, conversationId, documentId);
  if (!object) return null;
  const opened = await localFilesystemStorageProvider.readObject(object);
  if (opened.size !== object.size) throw new ChatDocumentError("document_storage_changed", "The document has changed since it was stored.", 409);
  return { object, ...opened };
}

export async function downloadAuthorizedDocumentBytes(ownerId: string, conversationId: string, documentId: string): Promise<Uint8Array | null> {
  const object = await getAuthorizedDocumentStorageObject(ownerId, conversationId, documentId);
  if (!object) return null;
  const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
  if (bytes.byteLength !== object.size) throw new ChatDocumentError("document_storage_changed", "The document has changed since it was stored.", 409);
  return bytes;
}

export async function getDocumentPages(ownerId: string, conversationId: string, pdfId: string, start = 1, end = 100000): Promise<ChatDocumentPage[]> {
  const data = await query<{ page_number: number; text: string; markdown: string | null; extraction_method: unknown; failure: unknown; provider_metadata: unknown }>("select page_number,text,markdown,extraction_method,failure,provider_metadata from chat_document_pages where owner_id=$1 and conversation_id=$2 and document_id=$3 and page_number >= $4 and page_number <= $5 order by page_number", [databaseOwnerId(ownerId), conversationId, pdfId, start, end]);
  return data.map((page) => ({
    pageNumber: Number(page.page_number),
    text: page.text,
    ...(typeof page.markdown === "string" ? { markdown: page.markdown } : {}),
    ...(storedProviderMetadata(page.provider_metadata) ? { providerMetadata: storedProviderMetadata(page.provider_metadata) } : {}),
    extractionMethod: storedPageMethod(page.extraction_method, page.text),
    ...(storedPageFailure(page.failure) ? { failure: storedPageFailure(page.failure) } : {}),
  }));
}

export async function uploadDocumentBytes(input: {
  ownerId: string;
  conversationId: string;
  documentId: string;
  filename: string;
  bytes: Uint8Array;
  contentType: ChatDocumentAttachment["contentType"];
  projectId?: string;
  revisionId?: string;
}): Promise<StorageObject> {
  return storeStorageObject({
    metadata: {
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      documentId: input.documentId,
      projectId: input.projectId,
      revisionId: input.revisionId,
      kind: "document",
      originalFilename: input.filename,
      contentType: input.contentType,
    },
    source: input.bytes,
    maxBytes: 25 * 1024 * 1024,
  });
}

export async function deleteDocument(input: { ownerId: string; conversationId: string; documentId: string; contentType: ChatDocumentAttachment["contentType"] }): Promise<void> {
  const [row] = await query<{ storage_object_id: string | null }>("select storage_object_id from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3 and content_type=$4", [databaseOwnerId(input.ownerId), input.conversationId, input.documentId, input.contentType]);
  const imageRows = await query<{ storage_object_id: string | null }>("select storage_object_id from chat_document_images where owner_id=$1 and conversation_id=$2 and document_id=$3", [databaseOwnerId(input.ownerId), input.conversationId, input.documentId]);
  const storageObjectIds = new Set([row?.storage_object_id, ...imageRows.map((image) => image.storage_object_id)].filter((objectId): objectId is string => Boolean(objectId)));
  for (const objectId of storageObjectIds) await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId });
  await query("delete from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3", [databaseOwnerId(input.ownerId), input.conversationId, input.documentId]);
}

/** Remove exact object records before the conversation row cascades. */
export async function deleteChatDocumentsForConversation(ownerId: string, conversationId: string): Promise<void> {
  const rows = await query<{ storage_object_id: string | null }>(
    `select storage_object_id from chat_documents where owner_id=$1 and conversation_id=$2
     union
     select images.storage_object_id
       from chat_document_images images
      where images.owner_id=$1 and images.conversation_id=$2`,
    [databaseOwnerId(ownerId), conversationId],
  );
  for (const row of rows) if (row.storage_object_id) await deleteOwnedStorageObject({ ownerId, objectId: row.storage_object_id });
}

/** Remove revision files that are not linked through chat_documents. */
export async function deleteRevisionStorageForConversation(ownerId: string, conversationId: string): Promise<void> {
  const rows = await query<{ storage_object_id: string | null }>("select storage_object_id from chat_document_revision_files where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
  for (const row of rows) if (row.storage_object_id) await deleteOwnedStorageObject({ ownerId, objectId: row.storage_object_id });
}
