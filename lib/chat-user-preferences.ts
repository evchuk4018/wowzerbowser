export type ChatUserPreferences = {
  userPresence: string;
};

export const DEFAULT_CHAT_USER_PREFERENCES: ChatUserPreferences = {
  userPresence: "",
};

export function parseChatUserPreferences(value: unknown): ChatUserPreferences | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { userPresence?: unknown };
  if (typeof candidate.userPresence !== "string" || candidate.userPresence.length > 12_000) return null;
  return { userPresence: candidate.userPresence.trim() };
}
