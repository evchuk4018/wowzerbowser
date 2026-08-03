import "server-only";

import { randomUUID } from "node:crypto";
import { databaseOwnerId, isoTimestamp, query } from "../database/database";
import { isStorageObjectId, validateStorageObjectKey, type StorageObject, type StorageObjectInput, type StorageObjectKind, type StorageObjectState } from "../../../lib/storage-protocol";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function storageObjectFromRow(row: Record<string, unknown>): StorageObject {
  return {
    objectId: String(row.object_id),
    ownerId: String(row.owner_id),
    conversationId: nullableString(row.conversation_id),
    documentId: nullableString(row.document_id),
    messageId: nullableString(row.message_id),
    projectId: nullableString(row.project_id),
    revisionId: nullableString(row.revision_id),
    kind: row.kind as StorageObjectKind,
    objectKey: String(row.object_key),
    originalFilename: nullableString(row.original_filename),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: nullableString(row.sha256),
    state: row.state as StorageObjectState,
    createdAt: isoTimestamp(row.created_at),
    completedAt: row.completed_at == null ? null : isoTimestamp(row.completed_at),
  };
}

export async function createStorageObject(input: StorageObjectInput): Promise<StorageObject> {
  const objectId = randomUUID();
  const objectKey = `objects/${objectId}`;
  const [row] = await query<Record<string, unknown>>(
    `insert into app_storage_objects
      (object_id,owner_id,conversation_id,document_id,message_id,project_id,revision_id,kind,object_key,original_filename,content_type,size,state)
     values($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,'uploading')
     returning *`,
    [objectId, databaseOwnerId(input.ownerId), input.conversationId ?? null, input.documentId ?? null, input.messageId ?? null, input.projectId ?? null, input.revisionId ?? null, input.kind, objectKey, input.originalFilename ?? null, input.contentType],
  );
  if (!row) throw new Error("Storage object metadata could not be created.");
  return storageObjectFromRow(row);
}

export async function getStorageObjectById(input: { ownerId: string; objectId: string; conversationId?: string; state?: StorageObjectState }): Promise<StorageObject | null> {
  if (!isStorageObjectId(input.objectId)) return null;
  const values: unknown[] = [databaseOwnerId(input.ownerId), input.objectId];
  let statement = "select * from app_storage_objects where owner_id=$1 and object_id=$2::uuid";
  if (input.conversationId !== undefined) {
    values.push(input.conversationId);
    statement += ` and conversation_id=$${values.length}`;
  }
  if (input.state !== undefined) {
    values.push(input.state);
    statement += ` and state=$${values.length}`;
  }
  const [row] = await query<Record<string, unknown>>(statement, values);
  return row ? storageObjectFromRow(row) : null;
}

export async function getStorageObjectByKey(input: { ownerId: string; objectKey: string; conversationId?: string; state?: StorageObjectState }): Promise<StorageObject | null> {
  try { validateStorageObjectKey(input.objectKey); } catch { return null; }
  const values: unknown[] = [databaseOwnerId(input.ownerId), input.objectKey];
  let statement = "select * from app_storage_objects where owner_id=$1 and object_key=$2";
  if (input.conversationId !== undefined) {
    values.push(input.conversationId);
    statement += ` and conversation_id=$${values.length}`;
  }
  if (input.state !== undefined) {
    values.push(input.state);
    statement += ` and state=$${values.length}`;
  }
  const [row] = await query<Record<string, unknown>>(statement, values);
  return row ? storageObjectFromRow(row) : null;
}

export async function completeStorageObject(input: { ownerId: string; objectId: string; size: number; sha256: string }): Promise<StorageObject> {
  if (!isStorageObjectId(input.objectId) || !Number.isSafeInteger(input.size) || input.size < 0 || !/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error("Storage object completion metadata is invalid.");
  }
  const [row] = await query<Record<string, unknown>>(
    `update app_storage_objects set size=$1,sha256=$2,state='complete',completed_at=now()
     where owner_id=$3 and object_id=$4::uuid and state='uploading' returning *`,
    [input.size, input.sha256, databaseOwnerId(input.ownerId), input.objectId],
  );
  if (!row) {
    const current = await getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId });
    if (current?.state === "complete" && current.size === input.size && current.sha256 === input.sha256) return current;
    throw new Error("Storage object metadata could not be completed.");
  }
  return storageObjectFromRow(row);
}

export async function failStorageObject(input: { ownerId: string; objectId: string }): Promise<void> {
  if (!isStorageObjectId(input.objectId)) return;
  await query("update app_storage_objects set state='failed' where owner_id=$1 and object_id=$2::uuid and state <> 'complete'", [databaseOwnerId(input.ownerId), input.objectId]);
}

export async function attachStorageObject(input: { ownerId: string; objectId: string; kind?: StorageObjectKind; conversationId?: string; documentId?: string | null; messageId?: string | null; projectId?: string | null; revisionId?: string | null }): Promise<StorageObject | null> {
  if (!isStorageObjectId(input.objectId)) return null;
  const values: unknown[] = [databaseOwnerId(input.ownerId), input.objectId];
  const updates: string[] = [];
  const add = (column: string, value: unknown) => { values.push(value); updates.push(`${column}=$${values.length}`); };
  if (input.kind !== undefined) add("kind", input.kind);
  if (input.conversationId !== undefined) add("conversation_id", input.conversationId);
  if (input.documentId !== undefined) add("document_id", input.documentId);
  if (input.messageId !== undefined) add("message_id", input.messageId);
  if (input.projectId !== undefined) add("project_id", input.projectId);
  if (input.revisionId !== undefined) add("revision_id", input.revisionId);
  if (!updates.length) return getStorageObjectById({ ownerId: input.ownerId, objectId: input.objectId });
  const [row] = await query<Record<string, unknown>>(`update app_storage_objects set ${updates.join(",")} where owner_id=$1 and object_id=$2::uuid returning *`, values);
  return row ? storageObjectFromRow(row) : null;
}

export async function getDocumentStorageObject(input: { ownerId: string; conversationId: string; documentId: string }): Promise<StorageObject | null> {
  const [row] = await query<Record<string, unknown>>(
    `select o.* from app_storage_objects o
     join chat_documents d on d.storage_object_id=o.object_id
     where d.owner_id=$1 and d.conversation_id=$2 and d.document_id=$3 and d.status='complete' and o.state='complete'`,
    [databaseOwnerId(input.ownerId), input.conversationId, input.documentId],
  );
  return row ? storageObjectFromRow(row) : null;
}

export async function getImageStorageObject(input: { ownerId: string; conversationId: string; imageId: string }): Promise<StorageObject | null> {
  const [row] = await query<Record<string, unknown>>(
    `select o.* from app_storage_objects o
     join chat_image_uploads i on i.storage_object_id=o.object_id
     where i.owner_id=$1 and i.conversation_id=$2 and i.image_id=$3 and i.status='complete' and o.state='complete'`,
    [databaseOwnerId(input.ownerId), input.conversationId, input.imageId],
  );
  return row ? storageObjectFromRow(row) : null;
}

export async function listStorageObjectsForConversation(ownerId: string, conversationId: string, limit = 1000): Promise<StorageObject[]> {
  const rows = await query<Record<string, unknown>>(
    "select * from app_storage_objects where owner_id=$1 and conversation_id=$2 order by created_at limit $3",
    [databaseOwnerId(ownerId), conversationId, Math.max(1, Math.min(limit, 1000))],
  );
  return rows.map(storageObjectFromRow);
}

export async function listAbandonedStorageObjects(ownerId: string, cutoff: Date, limit = 100): Promise<StorageObject[]> {
  const rows = await query<Record<string, unknown>>(
    `select objects.*
       from app_storage_objects objects
      where objects.owner_id=$1
        and objects.state in ('uploading','failed')
        and objects.created_at < $2
        and not exists (
          select 1 from document_processing_jobs jobs
           where jobs.owner_id=objects.owner_id
             and jobs.storage_object_id=objects.object_id
             and jobs.status in ('queued','running')
        )
        and not exists (
          select 1 from chat_image_processing_jobs jobs
           where jobs.owner_id=objects.owner_id
             and jobs.storage_object_id=objects.object_id
             and jobs.status in ('queued','running')
        )
        and not exists (
          select 1 from chat_documents documents
           where documents.owner_id=objects.owner_id
             and documents.storage_object_id=objects.object_id
             and documents.status='processing'
        )
        and not exists (
          select 1 from chat_image_uploads uploads
           where uploads.owner_id=objects.owner_id
             and uploads.storage_object_id=objects.object_id
             and uploads.status='processing'
        )
      order by objects.created_at
      limit $3`,
    [databaseOwnerId(ownerId), cutoff.toISOString(), Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(storageObjectFromRow);
}

export async function deleteStorageObjectMetadata(input: { ownerId: string; objectId: string }): Promise<void> {
  if (!isStorageObjectId(input.objectId)) return;
  await query("delete from app_storage_objects where owner_id=$1 and object_id=$2::uuid", [databaseOwnerId(input.ownerId), input.objectId]);
}

export async function deleteStorageObjectsForConversationMetadata(ownerId: string, conversationId: string): Promise<void> {
  await query("delete from app_storage_objects where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
}

export async function deleteDocumentStorageLink(input: { ownerId: string; conversationId: string; documentId: string }): Promise<StorageObject | null> {
  const object = await getDocumentStorageObject(input);
  if (object) await deleteStorageObjectMetadata({ ownerId: input.ownerId, objectId: object.objectId });
  return object;
}
