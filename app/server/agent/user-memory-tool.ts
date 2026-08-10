import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import {
  browseUserMemory,
  createUserMemory,
  createUserMemoryFolder,
  deleteUserMemory,
  readUserMemory,
  relocateUserMemory,
  updateUserMemory,
} from "../memory/user-memory-service";
import { formatBackgroundError } from "../observability/background-error";
import {
  ADD_USER_MEMORY_TOOL,
  BROWSE_USER_MEMORY_TOOL,
  CREATE_MEMORY_FOLDER_TOOL,
  DELETE_USER_MEMORY_TOOL,
  EDIT_USER_MEMORY_TOOL,
  MOVE_USER_MEMORY_TOOL,
  READ_USER_MEMORY_TOOL,
  USER_MEMORY_TOOL_DEFINITIONS,
} from "./user-memory-tool-manifest";

export type UserMemoryToolContext = {
  ownerId: string;
  conversationId: string;
  jobId: string;
};

const failure = (call: ChatToolCall, message: string): ChatToolResult => ({
  id: call.id, name: call.name, ok: false, stdout: "", stderr: message,
});

function objectArgs(call: ChatToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new Error("Invalid user-memory tool arguments.");
}

function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`${key} is required.`);
  return args[key].trim();
}

function pathArg(args: Record<string, unknown>, required = true): string[] | undefined {
  if (args.path === undefined && !required) return undefined;
  if (!Array.isArray(args.path) || !args.path.every((part) => typeof part === "string")) throw new Error("path must be an array of folder names.");
  return args.path as string[];
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  return args[key];
}

export function userMemoryToolDefinitions() {
  return USER_MEMORY_TOOL_DEFINITIONS;
}

export async function executeUserMemoryTool(call: ChatToolCall, context: UserMemoryToolContext): Promise<ChatToolResult> {
  try {
    const args = objectArgs(call);
    const writeContext = {
      ownerId: context.ownerId,
      sourceChatId: context.conversationId,
      sourceJobId: context.jobId,
      writer: "agent" as const,
    };
    let result: unknown;
    if (call.name === BROWSE_USER_MEMORY_TOOL) result = await browseUserMemory(context.ownerId, pathArg(args, false));
    else if (call.name === READ_USER_MEMORY_TOOL) result = await readUserMemory(context.ownerId, stringArg(args, "memoryId"));
    else if (call.name === CREATE_MEMORY_FOLDER_TOOL) result = await createUserMemoryFolder(writeContext, pathArg(args)!);
    else if (call.name === ADD_USER_MEMORY_TOOL) result = await createUserMemory(writeContext, pathArg(args)!, stringArg(args, "content"), optionalBooleanArg(args, "sensitive"));
    else if (call.name === EDIT_USER_MEMORY_TOOL) result = await updateUserMemory(writeContext, stringArg(args, "memoryId"), stringArg(args, "content"), optionalBooleanArg(args, "sensitive"));
    else if (call.name === MOVE_USER_MEMORY_TOOL) result = await relocateUserMemory(writeContext, stringArg(args, "memoryId"), pathArg(args)!);
    else if (call.name === DELETE_USER_MEMORY_TOOL) {
      await deleteUserMemory(writeContext, stringArg(args, "memoryId"));
      result = { deleted: true };
    } else return failure(call, `Unknown user-memory tool: ${call.name}`);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(result), stderr: "" };
  } catch (error) {
    return failure(call, formatBackgroundError(error));
  }
}
