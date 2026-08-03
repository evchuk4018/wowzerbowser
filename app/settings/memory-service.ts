"use client";

import type { MemoryView } from "../../lib/memory-protocol";
import { authFetch } from "../auth/auth-fetch";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The memory request failed.");
  return body;
}

export async function fetchMemoryView(): Promise<MemoryView> {
  return responseJson<MemoryView>(await authFetch("/api/memory", {
    cache: "no-store",
  }));
}

export async function updateMemory(id: string, content: string): Promise<void> {
  await responseJson<{ memory: unknown }>(await authFetch(`/api/memory/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ content }),
  }));
}

export async function deleteMemory(id: string): Promise<void> {
  const response = await authFetch(`/api/memory/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "The memory could not be deleted.");
  }
}
