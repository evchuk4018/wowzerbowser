import "server-only";

import { createHash } from "node:crypto";
import {
  USER_MEMORY_ROOT_NAME,
  normalizeMemoryKey,
  type UserMemory,
  type UserMemoryFolder,
  type UserMemoryTree,
  type UserMemoryWriter,
} from "../../../lib/user-memory";
import { asIsoTimestamp, databaseOwnerId, jsonb, query } from "../database/database";

export type MemoryWriteContext = {
  ownerId: string;
  sourceChatId: string;
  sourceJobId: string;
  writer: UserMemoryWriter;
  dreamingRunId?: string;
  actionIndex?: number;
};

type FolderRow = { id: string; parent_id: string | null; name: string; created_at: unknown };
type MemoryRow = { id: string; folder_id: string; content: string; source_chat_id: string; source_job_id: string; writer: UserMemoryWriter; created_at: unknown; updated_at: unknown };

async function ensureProfile(ownerId: string): Promise<void> {
  await query("insert into user_memory_profiles(owner_id) values($1) on conflict(owner_id) do nothing", [databaseOwnerId(ownerId)]);
}

async function nextRevision(ownerId: string): Promise<number> {
  await ensureProfile(ownerId);
  const databaseOwner = databaseOwnerId(ownerId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await query<{ revision: number }>("select revision from user_memory_profiles where owner_id=$1", [databaseOwner]);
    const [updated] = await query<{ revision: number }>("update user_memory_profiles set revision=revision+1,updated_at=$1 where owner_id=$2 and revision=$3 returning revision", [new Date().toISOString(), databaseOwner, Number(row.revision)]);
    if (updated) return Number(updated.revision);
  }
  throw new Error("The user profile changed concurrently.");
}

async function audit(context: MemoryWriteContext, operation: "create_folder" | "add" | "edit" | "move" | "delete" | "merge", input: { memoryId?: string; folderId?: string; before?: unknown; after?: unknown }): Promise<void> {
  const profileRevision = await nextRevision(context.ownerId);
  try {
    await query(`insert into user_memory_revisions(owner_id,profile_revision,memory_id,folder_id,operation,before_state,after_state,source_chat_id,source_job_id,writer,dreaming_run_id,action_index)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`, [databaseOwnerId(context.ownerId), profileRevision, input.memoryId ?? null, input.folderId ?? null, operation, jsonb(input.before ?? null), jsonb(input.after ?? null), context.sourceChatId, context.sourceJobId, context.writer, context.dreamingRunId ?? null, context.actionIndex ?? null]);
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
  }
}

function pathsFor(rows: FolderRow[]): Map<string, string[]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cache = new Map<string, string[]>();
  const visit = (id: string, seen = new Set<string>()): string[] => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (seen.has(id)) throw new Error("The user-memory folder tree contains a cycle.");
    seen.add(id);
    const row = byId.get(id);
    if (!row) return [USER_MEMORY_ROOT_NAME];
    const path = row.parent_id ? [...visit(row.parent_id, seen), row.name] : [USER_MEMORY_ROOT_NAME, row.name];
    cache.set(id, path);
    return path;
  };
  rows.forEach((row) => visit(row.id));
  return cache;
}

function folderValue(row: FolderRow, paths: Map<string, string[]>): UserMemoryFolder {
  return { id: row.id, parentId: row.parent_id, name: row.name, path: paths.get(row.id)!, createdAt: asIsoTimestamp(row.created_at) };
}

function memoryValue(row: MemoryRow): UserMemory {
  return { id: row.id, folderId: row.folder_id, content: row.content, sourceChatId: row.source_chat_id, sourceJobId: row.source_job_id, writer: row.writer, createdAt: asIsoTimestamp(row.created_at), updatedAt: asIsoTimestamp(row.updated_at) };
}

export async function getUserMemoryTree(ownerId: string): Promise<UserMemoryTree> {
  await ensureProfile(ownerId);
  const databaseOwner = databaseOwnerId(ownerId);
  const [[profile], folders, memories] = await Promise.all([
    query<{ revision: number }>("select revision from user_memory_profiles where owner_id=$1", [databaseOwner]),
    query<FolderRow>("select id,parent_id,name,created_at from user_memory_folders where owner_id=$1 and deleted_at is null order by name", [databaseOwner]),
    query<MemoryRow>("select id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at from user_memories where owner_id=$1 and deleted_at is null order by updated_at desc", [databaseOwner]),
  ]);
  const paths = pathsFor(folders);
  return { revision: Number(profile.revision), folders: folders.map((row) => folderValue(row, paths)), memories: memories.map(memoryValue) };
}

export async function ensureMemoryFolderPath(context: MemoryWriteContext, rawPath: string[]): Promise<UserMemoryFolder | null> {
  const path = rawPath[0] === USER_MEMORY_ROOT_NAME ? rawPath.slice(1) : rawPath;
  let parentId: string | null = null;
  let result: UserMemoryFolder | null = null;
  const owner = databaseOwnerId(context.ownerId);
  for (const [folderIndex, name] of path.entries()) {
    const normalized = normalizeMemoryKey(name);
    const rows: FolderRow[] = parentId
      ? await query<FolderRow>("select id,parent_id,name,created_at from user_memory_folders where owner_id=$1 and normalized_name=$2 and parent_id=$3 and deleted_at is null", [owner, normalized, parentId])
      : await query<FolderRow>("select id,parent_id,name,created_at from user_memory_folders where owner_id=$1 and normalized_name=$2 and parent_id is null and deleted_at is null", [owner, normalized]);
    let row: FolderRow | undefined = rows[0];
    if (!row) {
      try {
        [row] = await query<FolderRow>("insert into user_memory_folders(owner_id,parent_id,name,normalized_name,created_by,source_chat_id,source_job_id) values($1,$2,$3,$4,$5,$6,$7) returning id,parent_id,name,created_at", [owner, parentId, name, normalized, context.writer, context.sourceChatId, context.sourceJobId]);
        if (!row) throw new Error("The memory folder could not be created.");
        await audit({ ...context, ...(context.actionIndex === undefined ? {} : { actionIndex: context.actionIndex - 99 + folderIndex }) }, "create_folder", { folderId: row.id, after: { name: row.name, parentId: row.parent_id } });
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        const retry: FolderRow[] = parentId
          ? await query<FolderRow>("select id,parent_id,name,created_at from user_memory_folders where owner_id=$1 and normalized_name=$2 and parent_id=$3 and deleted_at is null", [owner, normalized, parentId])
          : await query<FolderRow>("select id,parent_id,name,created_at from user_memory_folders where owner_id=$1 and normalized_name=$2 and parent_id is null and deleted_at is null", [owner, normalized]);
        row = retry[0];
        if (!row) throw error;
      }
    }
    parentId = row.id;
    result = { id: row.id, parentId: row.parent_id, name: row.name, path: [], createdAt: asIsoTimestamp(row.created_at) };
  }
  return result;
}

function fingerprint(content: string): string {
  return createHash("sha256").update(normalizeMemoryKey(content)).digest("hex");
}

const memoryColumns = "id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at";

export async function addUserMemory(context: MemoryWriteContext, folderId: string, content: string): Promise<UserMemory> {
  const owner = databaseOwnerId(context.ownerId);
  try {
    const [row] = await query<MemoryRow>(`insert into user_memories(owner_id,folder_id,content,content_fingerprint,source_chat_id,source_job_id,writer) values($1,$2,$3,$4,$5,$6,$7) returning ${memoryColumns}`, [owner, folderId, content, fingerprint(content), context.sourceChatId, context.sourceJobId, context.writer]);
    const memory = memoryValue(row);
    await audit(context, "add", { memoryId: memory.id, folderId, after: memory });
    return memory;
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const [duplicate] = await query<MemoryRow>(`select ${memoryColumns} from user_memories where owner_id=$1 and folder_id=$2 and content_fingerprint=$3 and deleted_at is null`, [owner, folderId, fingerprint(content)]);
    if (!duplicate) throw error;
    return memoryValue(duplicate);
  }
}

async function currentMemory(ownerId: string, memoryId: string): Promise<MemoryRow> {
  const [row] = await query<MemoryRow>(`select ${memoryColumns} from user_memories where owner_id=$1 and id=$2 and deleted_at is null`, [databaseOwnerId(ownerId), memoryId]);
  if (!row) throw new Error("Memory not found.");
  return row;
}

export async function editUserMemory(context: MemoryWriteContext, memoryId: string, content: string): Promise<UserMemory> {
  const before = await currentMemory(context.ownerId, memoryId);
  const [row] = await query<MemoryRow>(`update user_memories set content=$1,content_fingerprint=$2,source_chat_id=$3,source_job_id=$4,writer=$5,updated_at=$6 where owner_id=$7 and id=$8 and deleted_at is null returning ${memoryColumns}`, [content, fingerprint(content), context.sourceChatId, context.sourceJobId, context.writer, new Date().toISOString(), databaseOwnerId(context.ownerId), memoryId]);
  if (!row) throw new Error("Memory not found.");
  const memory = memoryValue(row);
  await audit(context, "edit", { memoryId, folderId: memory.folderId, before: memoryValue(before), after: memory });
  return memory;
}

export async function editUserMemoryFromSettings(ownerId: string, memoryId: string, content: string): Promise<UserMemory | null> {
  const [row] = await query<MemoryRow>(`update user_memories set content=$1,content_fingerprint=$2,updated_at=$3 where owner_id=$4 and id=$5 and deleted_at is null returning ${memoryColumns}`, [content, fingerprint(content), new Date().toISOString(), databaseOwnerId(ownerId), memoryId]);
  return row ? memoryValue(row) : null;
}

export async function moveUserMemory(context: MemoryWriteContext, memoryId: string, folderId: string): Promise<UserMemory> {
  const before = await currentMemory(context.ownerId, memoryId);
  const [row] = await query<MemoryRow>(`update user_memories set folder_id=$1,source_chat_id=$2,source_job_id=$3,writer=$4,updated_at=$5 where owner_id=$6 and id=$7 and deleted_at is null returning ${memoryColumns}`, [folderId, context.sourceChatId, context.sourceJobId, context.writer, new Date().toISOString(), databaseOwnerId(context.ownerId), memoryId]);
  if (!row) throw new Error("Memory not found.");
  const memory = memoryValue(row);
  await audit(context, "move", { memoryId, folderId, before: memoryValue(before), after: memory });
  return memory;
}

export async function deleteUserMemory(context: MemoryWriteContext, memoryId: string): Promise<void> {
  const before = await currentMemory(context.ownerId, memoryId);
  const now = new Date().toISOString();
  await query("update user_memories set deleted_at=$1,updated_at=$1,source_chat_id=$2,source_job_id=$3,writer=$4 where owner_id=$5 and id=$6 and deleted_at is null", [now, context.sourceChatId, context.sourceJobId, context.writer, databaseOwnerId(context.ownerId), memoryId]);
  await audit(context, "delete", { memoryId, folderId: before.folder_id, before: memoryValue(before), after: null });
}

export async function deleteUserMemoryFromSettings(ownerId: string, memoryId: string): Promise<boolean> {
  return (await query<{ id: string }>("update user_memories set deleted_at=$1,updated_at=$1 where owner_id=$2 and id=$3 and deleted_at is null returning id", [new Date().toISOString(), databaseOwnerId(ownerId), memoryId])).length > 0;
}
