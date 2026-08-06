import "server-only";

import { createHash } from "node:crypto";
import type { ChatArtifact, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { WORKSPACE_LIMITS, workspaceFileFor, workspacePath, type WorkspaceChangedFile, type WorkspaceCommandResult } from "../../../lib/workspace-protocol";
import { registerArtifact } from "../artifacts/artifact-store";
import type { LocalPythonExecutor } from "../python/local-python-executor";
import {
  RUN_COMMAND_TOOL_NAME,
  WORKSPACE_DELETE_TOOL_NAME,
  WORKSPACE_LIST_TOOL_NAME,
  WORKSPACE_PATCH_TOOL_NAME,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_SEARCH_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAME,
} from "./workspace-tool-manifest";

export { WORKSPACE_TOOL_DEFINITIONS } from "./workspace-tool-manifest";

type WorkspaceToolContext = {
  ownerId: string;
  conversationId: string;
  executor: LocalPythonExecutor;
};

type WorkspaceToolDependencies = {
  registerArtifact: typeof registerArtifact;
};

const DEFAULT_DEPENDENCIES: WorkspaceToolDependencies = { registerArtifact };

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = (call: ChatToolCall, message: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr: message.slice(0, 2_000) });

function argsFor(call: ChatToolCall): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(call.arguments || "{}"); } catch { throw new Error("Workspace tool arguments must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function requiredPath(input: Record<string, unknown>): string {
  if (typeof input.path !== "string") throw new Error("path is required.");
  const path = workspacePath(input.path);
  if (!path) throw new Error("path must identify a file.");
  return path;
}

function optionalDirectoryPath(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} is invalid.`);
  return workspacePath(value);
}

function optionalSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) throw new Error("expectedSha256 is invalid.");
  return value.toLowerCase();
}

function boundedString(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > maximum) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${field} is invalid.`);
  return value as number;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function artifactFor(
  context: WorkspaceToolContext,
  path: string,
  bytes?: Uint8Array,
  dependencies: WorkspaceToolDependencies = DEFAULT_DEPENDENCIES,
): Promise<ChatArtifact> {
  const content = bytes ?? await context.executor.readWorkspaceFile(path);
  const metadata = workspaceFileFor(path, content.byteLength, hash(content));
  return dependencies.registerArtifact({
    ownerId: context.ownerId,
    conversationId: context.conversationId,
    name: metadata.name,
    contentType: metadata.contentType,
    bytes: content,
    workspacePath: metadata.path,
    language: metadata.language,
    preview: metadata.preview,
    editable: metadata.editable,
  });
}

function replaceText(text: string, oldText: string, newText: string, expectedOccurrences: number): string {
  const occurrences = oldText ? text.split(oldText).length - 1 : 0;
  if (occurrences !== expectedOccurrences) throw new Error(`Expected ${expectedOccurrences} occurrences but found ${occurrences}.`);
  return text.split(oldText).join(newText);
}

function applyUnifiedDiff(text: string, diff: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let cursor = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (!line || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      const match = /@@\s+-(\d+)/.exec(line);
      if (!match) throw new Error("Unified diff hunk header is invalid.");
      const target = Number(match[1]) - 1;
      if (target < cursor || target > lines.length) throw new Error("Unified diff hunk is out of range.");
      output.push(...lines.slice(cursor, target));
      cursor = target;
      continue;
    }
    if (line.startsWith(" ")) {
      if (lines[cursor] !== line.slice(1)) throw new Error("Unified diff context does not match.");
      output.push(lines[cursor++]);
    } else if (line.startsWith("-")) {
      if (lines[cursor] !== line.slice(1)) throw new Error("Unified diff removal does not match.");
      cursor += 1;
    } else if (line.startsWith("+")) {
      output.push(line.slice(1));
    } else {
      throw new Error("Unified diff contains an invalid line.");
    }
  }
  output.push(...lines.slice(cursor));
  return output.join("\n");
}

async function searchWorkspace(executor: LocalPythonExecutor, query: string, root: string, maxResults: number): Promise<Array<{ path: string; line: number; column: number; excerpt: string }>> {
  const files = await executor.listWorkspaceTree(root === "." ? "" : root);
  const lowerQuery = query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; column: number; excerpt: string }> = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    const normalized = file.path.toLocaleLowerCase();
    if (normalized.includes(lowerQuery)) matches.push({ path: file.path, line: 0, column: 0, excerpt: file.path });
    if (file.size > WORKSPACE_LIMITS.maxSearchFileBytes) continue;
    const bytes = await executor.readWorkspaceFile(file.path);
    const text = decoder.decode(bytes);
    if (text.includes("\u0000")) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const column = line.toLocaleLowerCase().indexOf(lowerQuery);
      if (column < 0) continue;
      matches.push({ path: file.path, line: index + 1, column: column + 1, excerpt: line.slice(Math.max(0, column - 80), column + query.length + 160) });
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
}

async function changedArtifacts(context: WorkspaceToolContext, changedFiles: WorkspaceChangedFile[] | undefined, dependencies: WorkspaceToolDependencies): Promise<ChatArtifact[]> {
  if (!changedFiles?.length) return [];
  const artifacts: ChatArtifact[] = [];
  for (const file of changedFiles.slice(0, 20)) {
    try { artifacts.push(await artifactFor(context, file.path, undefined, dependencies)); } catch { /* A command may remove a file after reporting it. */ }
  }
  return artifacts;
}

function commandResult(result: WorkspaceCommandResult): ChatToolResult {
  return {
    id: "",
    name: RUN_COMMAND_TOOL_NAME,
    ok: result.exitCode === 0 && !result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
  };
}

export async function executeWorkspaceTool(call: ChatToolCall, context: WorkspaceToolContext, dependencies: Partial<WorkspaceToolDependencies> = {}): Promise<ChatToolResult> {
  const activeDependencies: WorkspaceToolDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const startedAt = Date.now();
  try {
    const input = argsFor(call);
    if (call.name === WORKSPACE_LIST_TOOL_NAME) {
      const root = optionalDirectoryPath(input.path, "path");
      const files = await context.executor.listWorkspaceTree(root);
      return { id: call.id, name: call.name, ok: true, stdout: json(files.map((file) => workspaceFileFor(file.path, file.size))), stderr: "", durationMs: Date.now() - startedAt };
    }
    if (call.name === WORKSPACE_SEARCH_TOOL_NAME) {
      const query = boundedString(input.query, "query", WORKSPACE_LIMITS.maxSearchQueryLength, true)!;
      const root = optionalDirectoryPath(input.path, "path");
      const maxResults = boundedInteger(input.maxResults, "maxResults", 1, WORKSPACE_LIMITS.maxSearchResults, 50);
      const matches = await searchWorkspace(context.executor, query, root, maxResults);
      return { id: call.id, name: call.name, ok: true, stdout: json(matches), stderr: "", durationMs: Date.now() - startedAt };
    }
    if (call.name === WORKSPACE_READ_TOOL_NAME) {
      const path = requiredPath(input);
      const bytes = await context.executor.readWorkspaceFile(path);
      const hasLineRange = input.startLine !== undefined || input.endLine !== undefined;
      if (!hasLineRange && bytes.byteLength > WORKSPACE_LIMITS.maxReadBytes) throw new Error("The file is too large for a single read; use a line range or run a bounded command.");
      const text = decoder.decode(bytes);
      const start = boundedInteger(input.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER, 1);
      const end = boundedInteger(input.endLine, "endLine", start, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const lines = text.split(/\r?\n/);
      const output = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
      const boundedOutput = output.length > WORKSPACE_LIMITS.maxReadOutputLength
        ? `${output.slice(0, WORKSPACE_LIMITS.maxReadOutputLength)}\n[read output truncated]`
        : output;
      return { id: call.id, name: call.name, ok: true, stdout: boundedOutput, stderr: "", durationMs: Date.now() - startedAt };
    }
    if (call.name === WORKSPACE_WRITE_TOOL_NAME) {
      const path = requiredPath(input);
      const content = boundedString(input.content, "content", WORKSPACE_LIMITS.maxWriteBytes, false);
      if (content === undefined) throw new Error("content is required.");
      const bytes = encoder.encode(content);
      if (bytes.byteLength > WORKSPACE_LIMITS.maxWriteBytes) throw new Error("content is too large.");
      const expectedSha256 = optionalSha256(input.expectedSha256);
      await context.executor.writeWorkspaceFile(path, bytes, { overwrite: true, expectedSha256 });
      const artifact = await artifactFor(context, path, bytes, activeDependencies);
      return { id: call.id, name: call.name, ok: true, stdout: `Wrote ${path}.`, stderr: "", durationMs: Date.now() - startedAt, artifacts: [artifact] };
    }
    if (call.name === WORKSPACE_PATCH_TOOL_NAME) {
      const path = requiredPath(input);
      const oldText = boundedString(input.oldText, "oldText", 65_536);
      const newText = boundedString(input.newText, "newText", 65_536);
      const diff = boundedString(input.patch, "patch", 65_536);
      if ((oldText === undefined) !== (newText === undefined) || (oldText === undefined && diff === undefined) || (oldText !== undefined && diff !== undefined)) throw new Error("Provide oldText and newText, or provide patch.");
      const expectedOccurrences = boundedInteger(input.expectedOccurrences, "expectedOccurrences", 0, 100, 1);
      const currentBytes = await context.executor.readWorkspaceFile(path);
      const currentHash = hash(currentBytes);
      const expectedSha256 = optionalSha256(input.expectedSha256);
      if (expectedSha256 !== undefined && expectedSha256 !== currentHash) throw new Error("The file changed since it was read; reread it before patching.");
      const current = decoder.decode(currentBytes);
      const updated = oldText !== undefined ? replaceText(current, oldText, newText!, expectedOccurrences) : applyUnifiedDiff(current, diff!);
      const bytes = encoder.encode(updated);
      await context.executor.writeWorkspaceFile(path, bytes, { overwrite: true, expectedSha256: currentHash });
      const artifact = await artifactFor(context, path, bytes, activeDependencies);
      return { id: call.id, name: call.name, ok: true, stdout: `Patched ${path}.`, stderr: "", durationMs: Date.now() - startedAt, artifacts: [artifact] };
    }
    if (call.name === WORKSPACE_DELETE_TOOL_NAME) {
      const path = requiredPath(input);
      await context.executor.deleteWorkspaceFile(path);
      return { id: call.id, name: call.name, ok: true, stdout: `Deleted ${path}.`, stderr: "", durationMs: Date.now() - startedAt };
    }
    if (call.name === RUN_COMMAND_TOOL_NAME) {
      const command = boundedString(input.command, "command", 128, true)!;
      const args = input.args === undefined ? [] : input.args;
      if (!Array.isArray(args) || args.length > WORKSPACE_LIMITS.maxCommandArgs || args.some((arg) => typeof arg !== "string" || arg.length > WORKSPACE_LIMITS.maxCommandArgLength)) throw new Error("args are invalid.");
      const cwd = optionalDirectoryPath(input.cwd, "cwd");
      const stdin = boundedString(input.stdin, "stdin", 65_536);
      const timeoutMs = boundedInteger(input.timeoutMs, "timeoutMs", 100, WORKSPACE_LIMITS.maxCommandTimeoutMs, 30_000);
      const result = await context.executor.runCommand({ command, args: args as string[], cwd, stdin, timeoutMs });
      const base = commandResult(result);
      const artifacts = await changedArtifacts(context, result.changedFiles, activeDependencies);
      return { ...base, id: call.id, ...(artifacts.length ? { artifacts } : {}) };
    }
    return failure(call, `Unknown workspace tool: ${call.name}`);
  } catch (error) {
    return { ...failure(call, error instanceof Error ? error.message : "Workspace tool failed."), durationMs: Date.now() - startedAt };
  }
}
