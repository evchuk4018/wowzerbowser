import type { ChatSearchResponse, ChatSearchResult } from "../../lib/chat-search";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatSearch(
  query: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ChatSearchResult[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const response = await fetch(`/api/chat/search?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as ChatSearchResponse;
  return Array.isArray(body.conversations) ? body.conversations : [];
}
