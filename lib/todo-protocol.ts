export const MAX_TODOS = 5;

export type TodoStatus = "pending" | "completed";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  position: number;
};

export type TodoList = {
  revision: number;
  items: TodoItem[];
  updatedAt?: string;
};

export function hasActiveTodo(list: TodoList): boolean {
  return list.items.some((item) => item.status !== "completed");
}

export function normalizeTodoList(value: unknown): TodoList {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const raw = Array.isArray(input.items) ? input.items : [];
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id)
      ? candidate.id
      : `todo-${index + 1}`;
    const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 500) : "";
    if (!text || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text, status: candidate.status === "completed" ? "completed" : "pending", position: items.length });
    if (items.length === MAX_TODOS) break;
  }
  return {
    revision: typeof input.revision === "number" && Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    items,
    ...(typeof input.updatedAt === "string" ? { updatedAt: input.updatedAt } : {}),
  };
}
