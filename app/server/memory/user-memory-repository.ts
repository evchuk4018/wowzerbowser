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
import { getServerClient } from "../../auth/supabase-server-adapter";

const db = () => getServerClient();

export type MemoryWriteContext = {
  ownerId: string;
  sourceChatId: string;
  sourceJobId: string;
  writer: UserMemoryWriter;
  dreamingRunId?: string;
  actionIndex?: number;
};

type FolderRow = {
  id: string; parent_id: string | null; name: string; created_at: string;
};
type MemoryRow = {
  id: string; folder_id: string; content: string; source_chat_id: string; source_job_id: string;
  writer: UserMemoryWriter; created_at: string; updated_at: string;
};

async function ensureProfile(ownerId: string): Promise<void> {
  const { error } = await db().from("user_memory_profiles").upsert(
    { owner_id: ownerId, revision: 0 },
    { onConflict: "owner_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function nextRevision(ownerId: string): Promise<number> {
  await ensureProfile(ownerId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await db().from("user_memory_profiles")
      .select("revision").eq("owner_id", ownerId).single();
    if (error) throw error;
    const revision = Number(data.revision);
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await db().from("user_memory_profiles")
      .update({ revision: revision + 1, updated_at: now })
      .eq("owner_id", ownerId).eq("revision", revision).select("revision").maybeSingle();
    if (updateError) throw updateError;
    if (updated) return revision + 1;
  }
  throw new Error("The user profile changed concurrently.");
}

async function audit(
  context: MemoryWriteContext,
  operation: "create_folder" | "add" | "edit" | "move" | "delete" | "merge",
  input: { memoryId?: string; folderId?: string; before?: unknown; after?: unknown },
): Promise<void> {
  const profileRevision = await nextRevision(context.ownerId);
  const { error } = await db().from("user_memory_revisions").insert({
    owner_id: context.ownerId,
    profile_revision: profileRevision,
    memory_id: input.memoryId ?? null,
    folder_id: input.folderId ?? null,
    operation,
    before_state: input.before ?? null,
    after_state: input.after ?? null,
    source_chat_id: context.sourceChatId,
    source_job_id: context.sourceJobId,
    writer: context.writer,
    dreaming_run_id: context.dreamingRunId ?? null,
    action_index: context.actionIndex ?? null,
  });
  if (error && error.code !== "23505") throw error;
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
    const path = row.parent_id
      ? [...visit(row.parent_id, seen), row.name]
      : [USER_MEMORY_ROOT_NAME, row.name];
    cache.set(id, path);
    return path;
  };
  rows.forEach((row) => visit(row.id));
  return cache;
}

function folderValue(row: FolderRow, paths: Map<string, string[]>): UserMemoryFolder {
  return { id: row.id, parentId: row.parent_id, name: row.name, path: paths.get(row.id)!, createdAt: row.created_at };
}

function memoryValue(row: MemoryRow): UserMemory {
  return {
    id: row.id,
    folderId: row.folder_id,
    content: row.content,
    sourceChatId: row.source_chat_id,
    sourceJobId: row.source_job_id,
    writer: row.writer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUserMemoryTree(ownerId: string): Promise<UserMemoryTree> {
  await ensureProfile(ownerId);
  const client = db();
  const [profile, folders, memories] = await Promise.all([
    client.from("user_memory_profiles").select("revision").eq("owner_id", ownerId).single(),
    client.from("user_memory_folders").select("id,parent_id,name,created_at")
      .eq("owner_id", ownerId).is("deleted_at", null).order("name"),
    client.from("user_memories").select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at")
      .eq("owner_id", ownerId).is("deleted_at", null).order("updated_at", { ascending: false }),
  ]);
  if (profile.error) throw profile.error;
  if (folders.error) throw folders.error;
  if (memories.error) throw memories.error;
  const folderRows = (folders.data ?? []) as FolderRow[];
  const paths = pathsFor(folderRows);
  return {
    revision: Number(profile.data.revision),
    folders: folderRows.map((row) => folderValue(row, paths)),
    memories: ((memories.data ?? []) as MemoryRow[]).map(memoryValue),
  };
}

export async function ensureMemoryFolderPath(context: MemoryWriteContext, rawPath: string[]): Promise<UserMemoryFolder | null> {
  const path = rawPath[0] === USER_MEMORY_ROOT_NAME ? rawPath.slice(1) : rawPath;
  let parentId: string | null = null;
  let result: UserMemoryFolder | null = null;
  for (const [folderIndex, name] of path.entries()) {
    const normalized = normalizeMemoryKey(name);
    let query = db().from("user_memory_folders").select("id,parent_id,name,created_at")
      .eq("owner_id", context.ownerId).eq("normalized_name", normalized).is("deleted_at", null);
    query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
    const { data: existing, error: readError } = await query.maybeSingle();
    if (readError) throw readError;
    let row = existing as FolderRow | null;
    if (!row) {
      const { data, error } = await db().from("user_memory_folders").insert({
        owner_id: context.ownerId,
        parent_id: parentId,
        name,
        normalized_name: normalized,
        created_by: context.writer,
        source_chat_id: context.sourceChatId,
        source_job_id: context.sourceJobId,
      }).select("id,parent_id,name,created_at").single();
      if (error) {
        if (error.code === "23505") {
          let retry = db().from("user_memory_folders").select("id,parent_id,name,created_at")
            .eq("owner_id", context.ownerId).eq("normalized_name", normalized).is("deleted_at", null);
          retry = parentId ? retry.eq("parent_id", parentId) : retry.is("parent_id", null);
          const reread = await retry.single();
          if (reread.error) throw reread.error;
          row = reread.data as FolderRow;
        } else throw error;
      } else {
        row = data as FolderRow;
        await audit({
          ...context,
          ...(context.actionIndex === undefined ? {} : { actionIndex: context.actionIndex - 99 + folderIndex }),
        }, "create_folder", { folderId: row.id, after: { name: row.name, parentId: row.parent_id } });
      }
    }
    parentId = row.id;
    result = { id: row.id, parentId: row.parent_id, name: row.name, path: [], createdAt: row.created_at };
  }
  return result;
}

function fingerprint(content: string): string {
  return createHash("sha256").update(normalizeMemoryKey(content)).digest("hex");
}

export async function addUserMemory(context: MemoryWriteContext, folderId: string, content: string): Promise<UserMemory> {
  const { data, error } = await db().from("user_memories").insert({
    owner_id: context.ownerId,
    folder_id: folderId,
    content,
    content_fingerprint: fingerprint(content),
    source_chat_id: context.sourceChatId,
    source_job_id: context.sourceJobId,
    writer: context.writer,
  }).select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at").single();
  if (error) {
    if (error.code !== "23505") throw error;
    const duplicate = await db().from("user_memories")
      .select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at")
      .eq("owner_id", context.ownerId).eq("folder_id", folderId).eq("content_fingerprint", fingerprint(content))
      .is("deleted_at", null).single();
    if (duplicate.error) throw duplicate.error;
    return memoryValue(duplicate.data as MemoryRow);
  }
  const memory = memoryValue(data as MemoryRow);
  await audit(context, "add", { memoryId: memory.id, folderId, after: memory });
  return memory;
}

async function currentMemory(ownerId: string, memoryId: string): Promise<MemoryRow> {
  const { data, error } = await db().from("user_memories")
    .select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at")
    .eq("owner_id", ownerId).eq("id", memoryId).is("deleted_at", null).single();
  if (error) throw error;
  return data as MemoryRow;
}

export async function editUserMemory(context: MemoryWriteContext, memoryId: string, content: string): Promise<UserMemory> {
  const before = await currentMemory(context.ownerId, memoryId);
  const { data, error } = await db().from("user_memories").update({
    content,
    content_fingerprint: fingerprint(content),
    source_chat_id: context.sourceChatId,
    source_job_id: context.sourceJobId,
    writer: context.writer,
    updated_at: new Date().toISOString(),
  }).eq("owner_id", context.ownerId).eq("id", memoryId).is("deleted_at", null)
    .select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at").single();
  if (error) throw error;
  const memory = memoryValue(data as MemoryRow);
  await audit(context, "edit", { memoryId, folderId: memory.folderId, before: memoryValue(before), after: memory });
  return memory;
}

export async function editUserMemoryFromSettings(ownerId: string, memoryId: string, content: string): Promise<UserMemory | null> {
  const { data, error } = await db().from("user_memories").update({
    content,
    content_fingerprint: fingerprint(content),
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", memoryId).is("deleted_at", null)
    .select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at").maybeSingle();
  if (error) throw error;
  return data ? memoryValue(data as MemoryRow) : null;
}

export async function moveUserMemory(context: MemoryWriteContext, memoryId: string, folderId: string): Promise<UserMemory> {
  const before = await currentMemory(context.ownerId, memoryId);
  const { data, error } = await db().from("user_memories").update({
    folder_id: folderId,
    source_chat_id: context.sourceChatId,
    source_job_id: context.sourceJobId,
    writer: context.writer,
    updated_at: new Date().toISOString(),
  }).eq("owner_id", context.ownerId).eq("id", memoryId).is("deleted_at", null)
    .select("id,folder_id,content,source_chat_id,source_job_id,writer,created_at,updated_at").single();
  if (error) throw error;
  const memory = memoryValue(data as MemoryRow);
  await audit(context, "move", { memoryId, folderId, before: memoryValue(before), after: memory });
  return memory;
}

export async function deleteUserMemory(context: MemoryWriteContext, memoryId: string): Promise<void> {
  const before = await currentMemory(context.ownerId, memoryId);
  const now = new Date().toISOString();
  const { error } = await db().from("user_memories").update({
    deleted_at: now,
    updated_at: now,
    source_chat_id: context.sourceChatId,
    source_job_id: context.sourceJobId,
    writer: context.writer,
  }).eq("owner_id", context.ownerId).eq("id", memoryId).is("deleted_at", null);
  if (error) throw error;
  await audit(context, "delete", { memoryId, folderId: before.folder_id, before: memoryValue(before), after: null });
}

export async function deleteUserMemoryFromSettings(ownerId: string, memoryId: string): Promise<boolean> {
  const { data, error } = await db().from("user_memories").update({
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", memoryId).is("deleted_at", null)
    .select("id").maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
