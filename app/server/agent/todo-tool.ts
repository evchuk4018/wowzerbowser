import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";
import { completeTodo, getTodoList } from "../chat/chat-todo-store";

export const GET_TODOS_TOOL_NAME = "get_todos";
export const COMPLETE_TODO_TOOL_NAME = "complete_todo";

export const TODO_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: GET_TODOS_TOOL_NAME, description: "Read the current task todo list when you need to check progress. The list is not automatically included in context.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
  { type: "function", function: { name: COMPLETE_TODO_TOOL_NAME, description: "Mark one todo objective complete after you have actually finished it.", parameters: { type: "object", additionalProperties: false, required: ["todoId"], properties: { todoId: { type: "string", minLength: 1, maxLength: 64 } } } } },
];

const fail = (call: ChatToolCall, stderr: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr });

export async function executeTodoTool(call: ChatToolCall, context: { ownerId: string; conversationId: string; onUpdate?: (list: Awaited<ReturnType<typeof getTodoList>>) => Promise<void> }): Promise<ChatToolResult> {
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    if (call.name === GET_TODOS_TOOL_NAME) {
      const list = await getTodoList(context.ownerId, context.conversationId);
      return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(list), stderr: "" };
    }
    if (call.name === COMPLETE_TODO_TOOL_NAME) {
      if (typeof input.todoId !== "string" || !input.todoId.trim()) return fail(call, "todoId is required.");
      const list = await completeTodo(context.ownerId, context.conversationId, input.todoId.trim());
      await context.onUpdate?.(list);
      return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(list), stderr: "" };
    }
    return fail(call, `Unknown todo tool: ${call.name}`);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : "Todo operation failed.");
  }
}
