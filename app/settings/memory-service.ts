"use client";

import type { MemoryView } from "../../lib/memory-protocol";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The memory request failed.");
  return body;
}

export async function fetchMemoryView(token: string): Promise<MemoryView> {
  return responseJson<MemoryView>(await fetch("/api/memory", {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }));
}

export async function updateMemory(id: string, content: string, token: string): Promise<void> {
  await responseJson<{ memory: unknown }>(await fetch(`/api/memory/${id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content }),
  }));
}

export async function deleteMemory(id: string, token: string): Promise<void> {
  const response = await fetch(`/api/memory/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "The memory could not be deleted.");
  }
}
