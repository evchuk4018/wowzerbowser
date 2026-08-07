import "server-only";

import { createHash } from "node:crypto";
import { isValidConversationId } from "../../../lib/chat-conversation-id";
import { WORKSPACE_LIMITS, workspaceFileFor, workspacePath, type WorkspaceFile, type WorkspaceSearchMatch } from "../../../lib/workspace-protocol";
import { LocalPythonExecutor } from "../python/local-python-executor";
import { query } from "../database/database";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function workspaceSearchMaximum(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceSearchMaxResults;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(WORKSPACE_LIMITS.maxSearchResults, value))
    : WORKSPACE_LIMITS.maxSearchResults;
}

function workspaceSearchDefaultResults(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceSearchDefaultResults;
  const maximum = workspaceSearchMaximum();
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(maximum, value))
    : Math.min(maximum, 50);
}

function workspaceMaxReadOutputCharacters(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceMaxReadOutputCharacters;
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(1_000, Math.min(1_048_576, value)) : WORKSPACE_LIMITS.maxReadOutputLength;
}

function workspaceMaxSearchFileBytes(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceMaxSearchFileBytes;
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(8_000, Math.min(4 * 1024 * 1024, value)) : WORKSPACE_LIMITS.maxSearchFileBytes;
}

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

function validateConversationId(value: string): string {
  if (!isValidConversationId(value)) throw new WorkspaceRequestError(400, "Conversation id is invalid.");
  return value;
}

function metadata(path: string, size: number, sha256?: string): WorkspaceFile {
  return workspaceFileFor(path, size, sha256);
}

function lineRange(startLine: number | undefined, endLine: number | undefined): { start?: number; end?: number } {
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) throw new WorkspaceRequestError(400, "startLine is invalid.");
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < 1)) throw new WorkspaceRequestError(400, "endLine is invalid.");
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new WorkspaceRequestError(400, "endLine must be at least startLine.");
  return { ...(startLine === undefined ? {} : { start: startLine }), ...(endLine === undefined ? {} : { end: endLine }) };
}

async function workspaceIdForConversation(ownerId: string, conversationId: string): Promise<string> {
  try {
    const [row] = await query<{ project_id: string | null }>(
      "select project_id from chat_conversations where owner_id=$1 and conversation_id=$2",
      [ownerId, conversationId],
    );
    return row?.project_id ?? conversationId;
  } catch {
    return conversationId;
  }
}

async function withWorkspace<T>(ownerId: string, conversationId: string, callback: (executor: LocalPythonExecutor) => Promise<T>, workspaceId?: string): Promise<T> {
  validateConversationId(conversationId);
  const resolvedWorkspaceId = workspaceId ?? await workspaceIdForConversation(ownerId, conversationId);
  validateConversationId(resolvedWorkspaceId);
  const executor = new LocalPythonExecutor(ownerId, conversationId, Date.now() + 60_000, resolvedWorkspaceId);
  try {
    return await callback(executor);
  } catch (error) {
    if (error instanceof WorkspaceRequestError) throw error;
    const message = error instanceof Error ? error.message : "Workspace operation failed.";
    if (/already running|active session|conflict/i.test(message)) throw new WorkspaceRequestError(409, "The workspace is busy with another operation.");
    if (/not found/i.test(message)) throw new WorkspaceRequestError(404, "Workspace file not found.");
    if (/changed since|expected sha|conflict/i.test(message)) throw new WorkspaceRequestError(409, message);
    throw new WorkspaceRequestError(400, message);
  } finally {
    await executor.close().catch(() => undefined);
  }
}

export async function listWorkspaceFiles(ownerId: string, conversationId: string, root = ""): Promise<WorkspaceFile[]> {
  const normalizedRoot = root ? workspacePath(root) : "";
  return withWorkspace(ownerId, conversationId, async (executor) => {
    const files = await executor.listWorkspaceTree(normalizedRoot);
    return files.map((file) => metadata(file.path, file.size));
  });
}

export async function readWorkspaceFile(ownerId: string, conversationId: string, pathValue: string, startLine?: number, endLine?: number): Promise<{ file: WorkspaceFile; content: string }> {
  const path = workspacePath(pathValue);
  const range = lineRange(startLine, endLine);
  return withWorkspace(ownerId, conversationId, async (executor) => {
    const bytes = await executor.readWorkspaceFile(path);
    if (bytes.byteLength > WORKSPACE_LIMITS.maxReadBytes && startLine === undefined && endLine === undefined) throw new WorkspaceRequestError(413, "The file is too large to read in one response.");
    const maxOutputCharacters = workspaceMaxReadOutputCharacters();
    const content = decoder.decode(bytes);
    const selected = range.start === undefined && range.end === undefined
      ? content
      : content.split(/\r?\n/).slice((range.start ?? 1) - 1, range.end ?? Number.MAX_SAFE_INTEGER).join("\n");
    return { file: metadata(path, bytes.byteLength, hash(bytes)), content: selected.length > maxOutputCharacters ? `${selected.slice(0, maxOutputCharacters)}\n[read output truncated]` : selected };
  });
}

export async function readWorkspaceAsset(ownerId: string, conversationId: string, pathValue: string): Promise<{ file: WorkspaceFile; bytes: Uint8Array }> {
  const path = workspacePath(pathValue);
  return withWorkspace(ownerId, conversationId, async (executor) => {
    const bytes = await executor.readWorkspaceFile(path);
    return { file: metadata(path, bytes.byteLength, hash(bytes)), bytes };
  });
}

export async function searchWorkspaceFiles(ownerId: string, conversationId: string, query: string, root = "", maxResults?: number): Promise<WorkspaceSearchMatch[]> {
  if (!query.trim() || query.length > WORKSPACE_LIMITS.maxSearchQueryLength) throw new WorkspaceRequestError(400, "Search query is invalid.");
  const normalizedRoot = root ? workspacePath(root) : "";
  const limit = maxResults !== undefined && Number.isSafeInteger(maxResults) ? Math.min(Math.max(maxResults, 1), workspaceSearchMaximum()) : workspaceSearchDefaultResults();
  return withWorkspace(ownerId, conversationId, async (executor) => {
    const files = await executor.listWorkspaceTree(normalizedRoot);
    const needle = query.toLocaleLowerCase();
    const results: WorkspaceSearchMatch[] = [];
    for (const file of files) {
      if (results.length >= limit) break;
      if (file.path.toLocaleLowerCase().includes(needle)) results.push({ path: file.path, line: 0, column: 0, excerpt: file.path });
      if (file.size > workspaceMaxSearchFileBytes()) continue;
      const text = decoder.decode(await executor.readWorkspaceFile(file.path));
      if (text.includes("\u0000")) continue;
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        const column = line.toLocaleLowerCase().indexOf(needle);
        if (column < 0) continue;
        results.push({ path: file.path, line: index + 1, column: column + 1, excerpt: line.slice(Math.max(0, column - 80), column + query.length + 160) });
        if (results.length >= limit) break;
      }
    }
    return results;
  });
}

export async function writeWorkspaceFile(ownerId: string, conversationId: string, pathValue: string, content: string, expectedSha256?: string): Promise<{ file: WorkspaceFile; content: string }> {
  const path = workspacePath(pathValue);
  const bytes = encoder.encode(content);
  if (bytes.byteLength > WORKSPACE_LIMITS.maxWriteBytes) throw new WorkspaceRequestError(413, "Workspace file is too large.");
  return withWorkspace(ownerId, conversationId, async (executor) => {
    await executor.writeWorkspaceFile(path, bytes, { overwrite: true, expectedSha256 });
    return { file: metadata(path, bytes.byteLength, hash(bytes)), content };
  });
}

export async function deleteWorkspaceFile(ownerId: string, conversationId: string, pathValue: string): Promise<void> {
  const path = workspacePath(pathValue);
  await withWorkspace(ownerId, conversationId, async (executor) => {
    await executor.deleteWorkspaceFile(path);
  });
}
