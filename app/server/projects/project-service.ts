import "server-only";

import { randomUUID } from "node:crypto";
import {
  parseCreateChatProjectChatInput,
  parseCreateChatProjectInput,
  parseUpdateChatProjectInput,
  validateChatProjectFileMetadata,
  validateChatProjectId,
  type ChatProject,
  type ChatProjectChat,
  type ChatProjectFileMetadata,
  type CreateChatProjectChatInput,
  type CreateChatProjectInput,
  type UpdateChatProjectInput,
} from "../../../lib/chat-project-protocol";
import { getStorageObjectById } from "../storage/storage-repository";
import { localFilesystemStorageProvider } from "../storage/local-filesystem-storage";
import {
  deleteChatProjectRecord,
  getChatProjectForDeletion,
  claimChatProjectDeletion,
  getChatProject,
  insertChatProject,
  insertProjectChat,
  listChatProjects,
  listProjectChats,
  updateChatProject,
  ensureProjectChatConversation,
  ensureProjectLibraryConversation,
} from "./project-repository";
import {
  deleteProjectFileMetadata,
  getProjectFile,
  listProjectFiles,
} from "./project-file-repository";
import { deleteStorageObjectsForConversation, openOwnedStorageObject } from "../storage/storage-service";
import { deleteConversationWorkspace } from "../python/local-python-conversation-cleanup";
import { deleteChatProjectDocuments } from "../chat/chat-document-store";

export type ChatProjectErrorCode = "invalid" | "not_found" | "conflict" | "file_changed";

export class ChatProjectServiceError extends Error {
  constructor(readonly code: ChatProjectErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "ChatProjectServiceError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

function protocolError(error: unknown): never {
  throw new ChatProjectServiceError("invalid", error instanceof Error ? error.message : "Invalid project metadata.", 400);
}

function requireProject(project: ChatProject | null): ChatProject {
  if (!project) throw new ChatProjectServiceError("not_found", "Project not found.", 404);
  return project;
}

export async function listProjects(ownerId: string): Promise<ChatProject[]> {
  return listChatProjects(ownerId);
}

export async function getProject(ownerId: string, projectId: string): Promise<ChatProject | null> {
  try {
    validateChatProjectId(projectId);
  } catch (error) {
    protocolError(error);
  }
  return getChatProject(ownerId, projectId);
}

export async function createProject(ownerId: string, value: unknown): Promise<ChatProject> {
  let input: CreateChatProjectInput;
  try {
    input = parseCreateChatProjectInput(value);
  } catch (error) {
    protocolError(error);
  }
  try {
    const project = await insertChatProject({ ownerId, projectId: randomUUID(), ...input });
    await ensureProjectLibraryConversation({ ownerId, projectId: project.id });
    return project;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ChatProjectServiceError("conflict", "A project with this identifier already exists.", 409);
    throw error;
  }
}

export async function updateProject(ownerId: string, projectId: string, value: unknown): Promise<ChatProject> {
  let input: UpdateChatProjectInput;
  try {
    validateChatProjectId(projectId);
    input = parseUpdateChatProjectInput(value);
  } catch (error) {
    protocolError(error);
  }
  return requireProject(await updateChatProject({ ownerId, projectId, ...input }));
}

export async function deleteProject(ownerId: string, projectId: string): Promise<boolean> {
  try {
    validateChatProjectId(projectId);
  } catch (error) {
    protocolError(error);
  }
  const project = await getChatProjectForDeletion(ownerId, projectId);
  if (!project) return false;
  await claimChatProjectDeletion(ownerId, projectId);

  // Project files and the shared worker workspace are project-owned resources,
  // so remove them before deleting the project and its chats.
  await deleteChatProjectDocuments(ownerId, projectId);
  const files = await listProjectFiles(ownerId, projectId);
  for (const file of files) {
    const object = await getStorageObjectById({ ownerId, objectId: file.id });
    if (object?.chatProjectId === projectId) await localFilesystemStorageProvider.deleteObjectFile(object);
    await deleteProjectFileMetadata(ownerId, projectId, file.id);
  }
  for (const chat of await listProjectChats(ownerId, projectId)) {
    await deleteStorageObjectsForConversation(ownerId, chat.id);
  }
  await deleteConversationWorkspace(ownerId, projectId, projectId);
  return deleteChatProjectRecord(ownerId, projectId);
}

export async function listProjectChatsForOwner(ownerId: string, projectId: string): Promise<ChatProjectChat[]> {
  await requireProject(await getProject(ownerId, projectId));
  return listProjectChats(ownerId, projectId);
}

export async function createProjectChat(ownerId: string, projectId: string, value: unknown): Promise<ChatProjectChat> {
  let input: CreateChatProjectChatInput;
  try {
    validateChatProjectId(projectId);
    input = parseCreateChatProjectChatInput(value);
  } catch (error) {
    protocolError(error);
  }
  await requireProject(await getChatProject(ownerId, projectId));
  const chat = await insertProjectChat({
    ownerId,
    projectId,
    conversationId: input.conversationId,
    title: input.title ?? "New conversation",
  });
  if (!chat) throw new ChatProjectServiceError("conflict", "The project chat could not be created.", 409);
  return chat;
}

export async function ensureProjectConversation(ownerId: string, projectId: string, conversationId: string): Promise<void> {
  try {
    validateChatProjectId(projectId);
    validateChatProjectId(conversationId, "conversation identifier");
  } catch (error) {
    protocolError(error);
  }
  await requireProject(await getChatProject(ownerId, projectId));
  await ensureProjectLibraryConversation({ ownerId, projectId });
  await ensureProjectChatConversation({ ownerId, projectId, conversationId });
}

export async function listProjectFileMetadata(ownerId: string, projectId: string): Promise<ChatProjectFileMetadata[]> {
  await requireProject(await getProject(ownerId, projectId));
  return (await listProjectFiles(ownerId, projectId)).map((file) => validateChatProjectFileMetadata(file));
}

export async function readProjectFile(ownerId: string, projectId: string, fileId: string): Promise<{
  metadata: ChatProjectFileMetadata;
  stream: ReadableStream<Uint8Array>;
  size: number;
} | null> {
  await requireProject(await getProject(ownerId, projectId));
  const metadata = await getProjectFile(ownerId, projectId, fileId);
  if (!metadata || metadata.state !== "complete") return null;
  const opened = await openOwnedStorageObject({ ownerId, objectId: metadata.id });
  if (
    opened.object.chatProjectId !== projectId
    || opened.object.contentType !== metadata.contentType
    || opened.object.size !== metadata.size
    || opened.object.sha256 !== metadata.sha256
  ) {
    throw new ChatProjectServiceError("file_changed", "Project file metadata has changed.", 409);
  }
  return { metadata, stream: opened.stream, size: opened.size };
}

export async function deleteProjectFile(ownerId: string, projectId: string, fileId: string): Promise<boolean> {
  await requireProject(await getProject(ownerId, projectId));
  const metadata = await getProjectFile(ownerId, projectId, fileId);
  if (!metadata) return false;
  const object = await getStorageObjectById({ ownerId, objectId: metadata.id });
  if (!object || object.chatProjectId !== projectId) return false;
  await localFilesystemStorageProvider.deleteObjectFile(object);
  return deleteProjectFileMetadata(ownerId, projectId, fileId);
}
