import "server-only";

import type { ChatProjectFileMetadata, ChatProjectFileState } from "../../../lib/chat-project-protocol";
import type { StorageObjectState } from "../../../lib/storage-protocol";
import { databaseOwnerId, isoTimestamp, query } from "../database/database";

type ProjectFileRow = {
  object_id: string;
  chat_project_id: string;
  original_filename: string | null;
  content_type: string;
  size: number | string;
  sha256: string | null;
  state: StorageObjectState;
  created_at: unknown;
};

function safeFilename(value: string | null): string {
  const name = value?.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").trim();
  return name ? name.slice(0, 512) : "file";
}

function safeContentType(value: string): string {
  return value.trim().slice(0, 255) || "application/octet-stream";
}

function fileFromRow(row: ProjectFileRow): ChatProjectFileMetadata {
  return {
    id: String(row.object_id),
    projectId: String(row.chat_project_id),
    name: safeFilename(row.original_filename),
    contentType: safeContentType(String(row.content_type)),
    size: Number(row.size),
    sha256: row.sha256 === null ? null : String(row.sha256),
    state: row.state as ChatProjectFileState,
    createdAt: isoTimestamp(row.created_at),
  };
}

const PROJECT_FILE_COLUMNS = "object_id,chat_project_id,original_filename,content_type,size,sha256,state,created_at";

export async function listProjectFiles(ownerId: string, projectId: string): Promise<ChatProjectFileMetadata[]> {
  const rows = await query<ProjectFileRow>(
    `select ${PROJECT_FILE_COLUMNS} from app_storage_objects
     where owner_id=$1 and chat_project_id=$2
     order by created_at,object_id
     limit 1000`,
    [databaseOwnerId(ownerId), projectId],
  );
  return rows.map(fileFromRow);
}

export async function getProjectFile(ownerId: string, projectId: string, fileId: string): Promise<ChatProjectFileMetadata | null> {
  const [row] = await query<ProjectFileRow>(
    `select ${PROJECT_FILE_COLUMNS} from app_storage_objects
     where owner_id=$1 and chat_project_id=$2 and object_id=$3::uuid`,
    [databaseOwnerId(ownerId), projectId, fileId],
  );
  return row ? fileFromRow(row) : null;
}

export async function deleteProjectFileMetadata(ownerId: string, projectId: string, fileId: string): Promise<boolean> {
  const rows = await query<{ object_id: string }>(
    "delete from app_storage_objects where owner_id=$1 and chat_project_id=$2 and object_id=$3::uuid returning object_id",
    [databaseOwnerId(ownerId), projectId, fileId],
  );
  return Boolean(rows[0]);
}
