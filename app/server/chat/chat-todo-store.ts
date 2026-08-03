import "server-only";
import { normalizeTodoList, type TodoItem, type TodoList } from "../../../lib/todo-protocol";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";

export async function getTodoList(ownerId: string, conversationId: string): Promise<TodoList> {
  const [data] = await query<{ revision: number; items: unknown; updated_at: unknown }>(
    "select revision, items, updated_at from chat_todo_lists where owner_id = $1 and conversation_id = $2",
    [databaseOwnerId(ownerId), conversationId],
  );
  return normalizeTodoList({ revision: data?.revision ?? 0, items: data?.items ?? [], updatedAt: data?.updated_at == null ? undefined : isoTimestamp(data.updated_at) });
}

export async function replaceTodoList(ownerId: string, conversationId: string, items: TodoItem[]): Promise<TodoList> {
  const nextItems = items.map((item, position) => ({ ...item, position }));
  const updatedAt = new Date().toISOString();
  const [row] = await query<{ revision: number; items: unknown; updated_at: unknown }>(
    `insert into chat_todo_lists (owner_id, conversation_id, revision, items, updated_at)
     values ($1, $2, 1, $3::jsonb, $4)
     on conflict (owner_id, conversation_id) do update set revision=chat_todo_lists.revision+1, items=excluded.items, updated_at=excluded.updated_at
     returning revision, items, updated_at`,
    [databaseOwnerId(ownerId), conversationId, jsonb(nextItems), updatedAt],
  );
  return normalizeTodoList({ revision: Number(row.revision), items: row.items, updatedAt: isoTimestamp(row.updated_at) });
}

export async function completeTodo(ownerId: string, conversationId: string, todoId: string): Promise<TodoList> {
  const current = await getTodoList(ownerId, conversationId);
  const items = current.items.map((item) => item.id === todoId ? { ...item, status: "completed" as const } : item);
  return replaceTodoList(ownerId, conversationId, items);
}
