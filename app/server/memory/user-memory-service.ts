import "server-only";

import {
  USER_MEMORY_MAX_CONTENT_LENGTH,
  USER_MEMORY_MAX_DEPTH,
  USER_MEMORY_MAX_FOLDER_NAME_LENGTH,
  USER_MEMORY_MAX_PROFILE_LENGTH,
  USER_MEMORY_ROOT_NAME,
  normalizeMemoryText,
  type UserMemoryTree,
} from "../../../lib/user-memory";
import {
  addUserMemory,
  deleteUserMemory,
  editUserMemory,
  ensureMemoryFolderPath,
  getUserMemoryTree,
  moveUserMemory,
  type MemoryWriteContext,
} from "./user-memory-repository";

const SECRET_PATTERN = /\b(?:sk-[a-z0-9_-]{16,}|bearer\s+[a-z0-9._-]{16,}|password\s*[:=]|api[_ -]?key\s*[:=]|-----begin [a-z ]+private key-----)\b/i;

function validatePath(path: string[]): string[] {
  const normalized = path.map(normalizeMemoryText).filter(Boolean);
  const relative = normalized[0] === USER_MEMORY_ROOT_NAME ? normalized.slice(1) : normalized;
  if (!relative.length || relative.length > USER_MEMORY_MAX_DEPTH) throw new Error("Memory folder paths must contain between one and eight folders.");
  if (relative.some((part) => part.length > USER_MEMORY_MAX_FOLDER_NAME_LENGTH)) throw new Error("A memory folder name is too long.");
  return [USER_MEMORY_ROOT_NAME, ...relative];
}

function validateContent(content: string): string {
  const normalized = normalizeMemoryText(content);
  if (!normalized || normalized.length > USER_MEMORY_MAX_CONTENT_LENGTH) throw new Error("Memory content must be between 1 and 2,000 characters.");
  if (SECRET_PATTERN.test(normalized)) throw new Error("Secrets and credentials cannot be stored in user memory.");
  return normalized;
}

function serializedLength(tree: UserMemoryTree): number {
  const paths = new Map(tree.folders.map((folder) => [folder.id, folder.path.join(" / ")]));
  return tree.memories.reduce((total, memory) => total + (paths.get(memory.folderId)?.length ?? 0) + memory.content.length + 80, 0);
}

async function assertProfileCapacity(ownerId: string, extra: number): Promise<void> {
  const tree = await getUserMemoryTree(ownerId);
  if (serializedLength(tree) + extra > USER_MEMORY_MAX_PROFILE_LENGTH) throw new Error("The user profile has reached its storage limit.");
}

export async function browseUserMemory(ownerId: string, path?: string[]): Promise<{
  path: string[];
  revision: number;
  folders: UserMemoryTree["folders"];
  memories: UserMemoryTree["memories"];
}> {
  const tree = await getUserMemoryTree(ownerId);
  const target = path?.length ? validatePath(path) : [USER_MEMORY_ROOT_NAME];
  const targetFolder = target.length === 1 ? null : tree.folders.find((folder) =>
    folder.path.length === target.length && folder.path.every((part, index) => part === target[index]));
  if (target.length > 1 && !targetFolder) throw new Error("Memory folder not found.");
  return {
    path: target,
    revision: tree.revision,
    folders: tree.folders.filter((folder) => folder.parentId === (targetFolder?.id ?? null)),
    memories: targetFolder ? tree.memories.filter((memory) => memory.folderId === targetFolder.id) : [],
  };
}

export async function readUserMemory(ownerId: string, memoryId: string) {
  const tree = await getUserMemoryTree(ownerId);
  const memory = tree.memories.find((candidate) => candidate.id === memoryId);
  if (!memory) throw new Error("Memory not found.");
  const folder = tree.folders.find((candidate) => candidate.id === memory.folderId);
  return { ...memory, path: folder?.path ?? [USER_MEMORY_ROOT_NAME] };
}

export async function createUserMemoryFolder(context: MemoryWriteContext, path: string[]) {
  await assertProfileCapacity(context.ownerId, path.join("/").length);
  const folder = await ensureMemoryFolderPath(context, validatePath(path));
  if (!folder) throw new Error("Memory folder could not be created.");
  return folder;
}

export async function createUserMemory(context: MemoryWriteContext, path: string[], content: string) {
  const validContent = validateContent(content);
  await assertProfileCapacity(context.ownerId, validContent.length + path.join("/").length);
  const folder = await ensureMemoryFolderPath(context, validatePath(path));
  if (!folder) throw new Error("A destination folder is required.");
  return addUserMemory(context, folder.id, validContent);
}

export async function updateUserMemory(context: MemoryWriteContext, memoryId: string, content: string) {
  const validContent = validateContent(content);
  await assertProfileCapacity(context.ownerId, validContent.length);
  return editUserMemory(context, memoryId, validContent);
}

export async function relocateUserMemory(context: MemoryWriteContext, memoryId: string, path: string[]) {
  const folder = await ensureMemoryFolderPath(context, validatePath(path));
  if (!folder) throw new Error("A destination folder is required.");
  return moveUserMemory(context, memoryId, folder.id);
}

export { deleteUserMemory, getUserMemoryTree };
