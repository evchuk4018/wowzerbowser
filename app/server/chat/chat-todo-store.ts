import "server-only";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { normalizeTodoList, type TodoItem, type TodoList } from "../../../lib/todo-protocol";

const client = () => getServerClient();

export async function getTodoList(ownerId: string, conversationId: string): Promise<TodoList> {
  const { data, error } = await client().from("chat_todo_lists").select("revision,items,updated_at")
    .eq("owner_id", ownerId).eq("conversation_id", conversationId).maybeSingle();
  if (error) throw error;
  return normalizeTodoList({ revision: data?.revision ?? 0, items: data?.items ?? [], updatedAt: data?.updated_at });
}

export async function replaceTodoList(ownerId: string, conversationId: string, items: TodoItem[]): Promise<TodoList> {
  const current = await getTodoList(ownerId, conversationId);
  const next: TodoList = { revision: current.revision + 1, items: items.map((item, position) => ({ ...item, position })), updatedAt: new Date().toISOString() };
  const { error } = await client().from("chat_todo_lists").upsert({
    owner_id: ownerId, conversation_id: conversationId, revision: next.revision, items: next.items, updated_at: next.updatedAt,
  }, { onConflict: "owner_id,conversation_id" });
  if (error) throw error;
  return next;
}

export async function completeTodo(ownerId: string, conversationId: string, todoId: string): Promise<TodoList> {
  const current = await getTodoList(ownerId, conversationId);
  const items = current.items.map((item) => item.id === todoId ? { ...item, status: "completed" as const } : item);
  return replaceTodoList(ownerId, conversationId, items);
}
