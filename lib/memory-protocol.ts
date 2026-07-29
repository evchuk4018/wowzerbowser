import type { UserMemoryTree } from "./user-memory";

export type MemorySummary = {
  conversationId: string;
  title: string;
  summary: string;
  revision: number;
  updatedAt: string;
};

export type MemoryView = {
  profile: UserMemoryTree;
  summaries: MemorySummary[];
};

export type MemoryUpdate = {
  content: string;
};

export function parseMemoryUpdate(value: unknown): MemoryUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  return typeof content === "string" ? { content } : null;
}
