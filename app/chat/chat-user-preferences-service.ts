import type { ChatUserPreferences } from "../../lib/chat-user-preferences";
import { authFetch } from "../auth/auth-fetch";

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatUserPreferences(): Promise<ChatUserPreferences> {
  const response = await authFetch("/api/chat/user-preferences");
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { preferences?: ChatUserPreferences };
  return body.preferences ?? { userPresence: "" };
}

export async function saveChatUserPreferences(preferences: ChatUserPreferences): Promise<void> {
  const response = await authFetch("/api/chat/user-preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preferences),
  });
  if (!response.ok) throw new Error(await readError(response));
}
