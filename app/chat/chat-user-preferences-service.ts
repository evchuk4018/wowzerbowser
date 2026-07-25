import type { ChatUserPreferences } from "../../lib/chat-user-preferences";

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatUserPreferences(accessToken: string): Promise<ChatUserPreferences> {
  const response = await fetch("/api/chat/user-preferences", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { preferences?: ChatUserPreferences };
  return body.preferences ?? { userPresence: "" };
}

export async function saveChatUserPreferences(preferences: ChatUserPreferences, accessToken: string): Promise<void> {
  const response = await fetch("/api/chat/user-preferences", {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(preferences),
  });
  if (!response.ok) throw new Error(await readError(response));
}
