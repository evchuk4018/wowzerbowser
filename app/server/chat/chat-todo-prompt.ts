import { hasActiveTodo, type TodoList } from "../../../lib/todo-protocol";

export const ACTIVE_TODO_SYSTEM_PROMPT = "There’s a todo active. View if you need a reminder of what to do.";

export function appendActiveTodoSystemPrompt(systemPrompt: string, todos: TodoList): string {
  if (!hasActiveTodo(todos) || systemPrompt.includes(ACTIVE_TODO_SYSTEM_PROMPT)) return systemPrompt;
  return [systemPrompt, ACTIVE_TODO_SYSTEM_PROMPT].filter(Boolean).join("\n\n");
}
