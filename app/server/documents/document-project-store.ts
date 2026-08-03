import "server-only";

import { DOCUMENT_PROJECT_LIMITS, validateDocumentProjectManifest, type DocumentProjectManifestV1 } from "../../../lib/document-project";
import { databaseOwnerId, jsonb, query } from "../database/database";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import { getStorageObjectById } from "../storage/storage-repository";
import { deleteOwnedStorageObject, storeStorageObject } from "../storage/storage-service";
import { downloadAuthorizedDocumentBytes } from "../chat/chat-document-store";

const MAX_STORAGE_OBJECT_BYTES = DOCUMENT_PROJECT_LIMITS.maxFileBytes;

/**
 * The revision source path is now represented by a UUID-keyed storage object.
 * Keep this helper as a compatibility boundary for callers that need a
 * logical label, but never use the returned value as a filesystem path.
 */
export function revisionSourceStoragePath(input: { relativePath: string }): string {
  return `revision-source:${input.relativePath}`;
}

export function createDocumentProjectStore(_unusedDependency?: unknown) {
  void _unusedDependency;
  return {
    async createProject(input: { ownerId: string; conversationId: string; projectId: string; title: string; origin?: "generated" | "uploaded" }) {
      await query("insert into chat_document_projects(owner_id,conversation_id,project_id,title,origin) values($1,$2,$3,$4,$5)", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.title, input.origin ?? "generated"]);
    },
    async registerRevision(input: { ownerId: string; conversationId: string; manifest: DocumentProjectManifestV1; renderedDocumentId: string }) {
      const m = validateDocumentProjectManifest(input.manifest);
      await query(`insert into chat_document_revisions(owner_id,conversation_id,project_id,revision_id,parent_revision_id,rendered_document_id,entrypoint,output_path,output_filename,output_content_type,output_sha256,source_completeness,manifest,status,created_by_job_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'creating',$14)`, [databaseOwnerId(input.ownerId), input.conversationId, m.projectId, m.revisionId, m.parentRevisionId, input.renderedDocumentId, m.entrypoint, m.outputPath, m.outputFilename, m.outputContentType, m.outputSha256, m.sourceCompleteness, jsonb(m), m.createdByJobId]);
    },
    async uploadSourceFiles(input: { ownerId: string; conversationId: string; manifest: DocumentProjectManifestV1; files: Map<string, Uint8Array> }) {
      const owner = databaseOwnerId(input.ownerId);
      for (const file of input.manifest.sourceFiles) {
        const bytes = input.files.get(file.path);
        if (!bytes) throw new Error(`Missing captured source file: ${file.path}`);
        if (bytes.byteLength !== file.size) throw new Error(`Captured source file size does not match the manifest: ${file.path}`);
        const object = await storeStorageObject({
          metadata: {
            ownerId: input.ownerId,
            conversationId: input.conversationId,
            projectId: input.manifest.projectId,
            revisionId: input.manifest.revisionId,
            kind: "revision-source",
            originalFilename: file.path.split("/").pop() ?? "source",
            contentType: file.contentType,
          },
          source: bytes,
          maxBytes: MAX_STORAGE_OBJECT_BYTES,
        });
        if (object.size !== file.size || object.sha256 !== file.sha256) {
          await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId: object.objectId }).catch(() => undefined);
          throw new Error(`Captured source file hash does not match the manifest: ${file.path}`);
        }
        try {
          await query("insert into chat_document_revision_files(owner_id,conversation_id,project_id,revision_id,relative_path,storage_path,storage_object_id,content_type,size,sha256) values($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10)", [owner, input.conversationId, input.manifest.projectId, input.manifest.revisionId, file.path, object.objectKey, object.objectId, file.contentType, file.size, file.sha256]);
        } catch (error) {
          await deleteOwnedStorageObject({ ownerId: input.ownerId, objectId: object.objectId }).catch(() => undefined);
          throw error;
        }
      }
    },
    async finalizeRevision(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      await query("update chat_document_revisions set status='complete' where owner_id=$1 and conversation_id=$2 and project_id=$3 and revision_id=$4 and status='creating'", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
    },
    async updateRevisionManifest(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string; manifest: DocumentProjectManifestV1 }) {
      const m = validateDocumentProjectManifest(input.manifest);
      await query("update chat_document_revisions set parent_revision_id=$1,entrypoint=$2,output_path=$3,output_filename=$4,output_sha256=$5,source_completeness=$6,manifest=$7::jsonb where owner_id=$8 and conversation_id=$9 and project_id=$10 and revision_id=$11 and status='creating'", [m.parentRevisionId, m.entrypoint, m.outputPath, m.outputFilename, m.outputSha256, m.sourceCompleteness, jsonb(m), databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
    },
    async updateRenderedDocumentId(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string; renderedDocumentId: string }) {
      await query("update chat_document_revisions set rendered_document_id=$1 where owner_id=$2 and conversation_id=$3 and project_id=$4 and revision_id=$5 and status='creating'", [input.renderedDocumentId, databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
    },
    async markRevisionFailed(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      await query("update chat_document_revisions set status='failed' where owner_id=$1 and conversation_id=$2 and project_id=$3 and revision_id=$4", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
    },
    async getRevision(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      const [row] = await query<Record<string, unknown>>("select * from chat_document_revisions where owner_id=$1 and conversation_id=$2 and project_id=$3 and revision_id=$4", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
      return row ?? null;
    },
    async getProjectRevisionMetadata(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      const [project] = await query<{ origin: "generated" | "uploaded" }>("select origin from chat_document_projects where owner_id=$1 and conversation_id=$2 and project_id=$3", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId]);
      const revision = await this.getRevision(input);
      return project && revision ? { origin: project.origin, sourceCompleteness: revision.source_completeness as "complete" | "entrypoint-only" } : null;
    },
    async listRevisionFiles(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      return query<Record<string, unknown>>("select relative_path,storage_path,storage_object_id,content_type,size,sha256 from chat_document_revision_files where owner_id=$1 and conversation_id=$2 and project_id=$3 and revision_id=$4 order by relative_path", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId]);
    },
    async downloadRevisionSourceFile(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string; relativePath: string }) {
      const [row] = await query<{ storage_object_id: string | null; content_type: string; size: number; sha256: string }>("select storage_object_id,content_type,size,sha256 from chat_document_revision_files where owner_id=$1 and conversation_id=$2 and project_id=$3 and revision_id=$4 and relative_path=$5", [databaseOwnerId(input.ownerId), input.conversationId, input.projectId, input.revisionId, input.relativePath]);
      if (!row?.storage_object_id) return null;
      const object = await getStorageObjectById({ ownerId: input.ownerId, objectId: row.storage_object_id, conversationId: input.conversationId, state: "complete" });
      if (!object || object.kind !== "revision-source" || object.projectId !== input.projectId || object.revisionId !== input.revisionId || object.contentType !== row.content_type || object.size !== Number(row.size) || object.sha256 !== row.sha256) return null;
      const bytes = await localFilesystemStorageProvider.readObjectBytes(object);
      if (bytes.byteLength !== object.size) throw new Error("The revision source storage object size does not match its metadata.");
      return bytes;
    },
    async downloadRevisionOutput(input: { ownerId: string; conversationId: string; projectId: string; revisionId: string }) {
      const revision = await this.getRevision(input);
      if (!revision || typeof revision.rendered_document_id !== "string") return null;
      return downloadAuthorizedDocumentBytes(input.ownerId, input.conversationId, revision.rendered_document_id);
    },
  };
}
