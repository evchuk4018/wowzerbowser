import type { ChatModelPreference } from "../../lib/chat-model-preference";
import { authFetch } from "../auth/auth-fetch";

type StoredChatModelPreference = ChatModelPreference & { conversationId: string };

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatModelPreferences() {
  const response = await authFetch("/api/chat/preferences");
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { preferences?: StoredChatModelPreference[] };
  return Object.fromEntries(
    (body.preferences ?? []).map(({ conversationId, ...preference }) => [conversationId, preference]),
  ) as Record<string, ChatModelPreference>;
}

export async function saveChatModelPreference(
  conversationId: string,
  preference: ChatModelPreference,
) {
  const response = await authFetch("/api/chat/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, preference }),
  });
  if (!response.ok) throw new Error(await readError(response));
}
