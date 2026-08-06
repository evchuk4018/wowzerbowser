import type {
  ChatConversation,
  ChatConversationSummary,
  ChatHistoryMessage,
} from "./chat-history";
import {
  parseChatModelPreference,
  type ChatModelPreference,
} from "./chat-model-preference";
import {
  DEFAULT_CHAT_USER_PREFERENCES,
  parseChatUserPreferences,
  type ChatUserPreferences,
} from "./chat-user-preferences";
import { isValidConversationId } from "./chat-conversation-id";

export type ChatBootstrapUser = {
  id: string;
  email: string;
};

export type StoredChatModelPreference = ChatModelPreference & {
  conversationId: string;
};

export type ChatBootstrapPayload = {
  user: ChatBootstrapUser;
  summaries: ChatConversationSummary[];
  streamingByConversation: Record<string, "persisted">;
  activeConversation: ChatConversation | null;
  activeConversationId: string | null;
  requestedConversationId: string | null;
  userPreferences: ChatUserPreferences;
  modelPreferences: StoredChatModelPreference[];
};

export type ChatBootstrapSelection = {
  requestedConversationId: string | null;
  activeConversationId: string | null;
  loadConversationId: string | null;
};

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeSummary(value: unknown): ChatConversationSummary | null {
  const candidate = asRecord(value);
  const id = requiredString(candidate?.id);
  if (!id || typeof candidate?.title !== "string" || typeof candidate.updatedAt !== "string"
    || typeof candidate.hasMessages !== "boolean" || typeof candidate.isStreaming !== "boolean") {
    return null;
  }
  return {
    id,
    title: candidate.title,
    updatedAt: candidate.updatedAt,
    hasMessages: candidate.hasMessages,
    isStreaming: candidate.isStreaming,
    ...(typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {}),
  };
}

function normalizeMessage(value: unknown): ChatHistoryMessage | null {
  const candidate = asRecord(value);
  if (!candidate || !requiredString(candidate.id)
    || (candidate.role !== "user" && candidate.role !== "assistant")
    || typeof candidate.content !== "string") {
    return null;
  }
  return { ...candidate, id: candidate.id, role: candidate.role, content: candidate.content } as ChatHistoryMessage;
}

function normalizeConversation(value: unknown): ChatConversation | null {
  const candidate = asRecord(value);
  const id = requiredString(candidate?.id);
  if (!id || typeof candidate?.title !== "string" || !Array.isArray(candidate.turns)) return null;

  const turns: ChatConversation["turns"] = [];
  for (const rawTurn of candidate.turns) {
    const turn = asRecord(rawTurn);
    if (!turn || !requiredString(turn.id) || !Array.isArray(turn.versions)) return null;
    const versions: ChatConversation["turns"][number]["versions"] = [];
    for (const rawVersion of turn.versions) {
      const version = asRecord(rawVersion);
      const user = normalizeMessage(version?.user);
      const assistant = normalizeMessage(version?.assistant);
      const versionId = requiredString(version?.id);
      if (!version || !versionId || !user || user.role !== "user"
        || !assistant || assistant.role !== "assistant") return null;
      versions.push({
        id: versionId,
        user,
        assistant,
        ...(typeof version.parentVersionId === "string" || version.parentVersionId === null
          ? { parentVersionId: version.parentVersionId }
          : {}),
      });
    }
    if (!versions.length) return null;
    const activeVersion = typeof turn.activeVersion === "number" && Number.isInteger(turn.activeVersion)
      ? turn.activeVersion
      : 0;
    if (activeVersion < 0 || activeVersion >= versions.length) return null;
    turns.push({ id: turn.id as string, versions, activeVersion });
  }
  return {
    id,
    title: candidate.title,
    ...(typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {}),
    turns,
  };
}

export function resolveChatBootstrapSelection(
  summaries: readonly ChatConversationSummary[],
  requestedConversationId?: string,
): ChatBootstrapSelection {
  const requestedId = isValidConversationId(requestedConversationId)
    ? requestedConversationId
    : null;
  return {
    requestedConversationId: requestedId,
    activeConversationId: requestedId && summaries.some(({ id }) => id === requestedId)
      ? requestedId
      : null,
    loadConversationId: requestedId,
  };
}

export function streamingMapFor(
  summaries: readonly ChatConversationSummary[],
): Record<string, "persisted"> {
  return Object.fromEntries(
    summaries.filter(({ isStreaming }) => isStreaming).map(({ id }) => [id, "persisted"]),
  );
}

export function modelPreferencesRecord(
  values: readonly StoredChatModelPreference[],
): Record<string, ChatModelPreference> {
  return Object.fromEntries(values.map(({ conversationId, ...preference }) => [conversationId, preference]));
}

export function parseChatBootstrapPayload(value: unknown): ChatBootstrapPayload {
  const candidate = asRecord(value);
  const user = asRecord(candidate?.user);
  if (!candidate || !user || !requiredString(user.id) || !requiredString(user.email)
    || !Array.isArray(candidate.summaries) || !Array.isArray(candidate.modelPreferences)) {
    throw new Error("Invalid chat bootstrap response.");
  }

  const summaries = candidate.summaries.map(normalizeSummary);
  if (summaries.some((summary) => summary === null)) throw new Error("Invalid chat bootstrap response.");
  const normalizedSummaries = summaries as ChatConversationSummary[];
  const activeConversation = candidate.activeConversation === null
    ? null
    : normalizeConversation(candidate.activeConversation);
  if (candidate.activeConversation !== null && !activeConversation) {
    throw new Error("Invalid chat bootstrap response.");
  }
  const activeConversationId = candidate.activeConversationId === null
    ? null
    : requiredString(candidate.activeConversationId);
  const requestedConversationId = candidate.requestedConversationId === null
    ? null
    : requiredString(candidate.requestedConversationId);
  if ((candidate.activeConversationId !== null && !activeConversationId)
    || (candidate.requestedConversationId !== null
      && (!requestedConversationId || !isValidConversationId(requestedConversationId)))) {
    throw new Error("Invalid chat bootstrap response.");
  }

  const preferences = candidate.userPreferences === undefined
    ? DEFAULT_CHAT_USER_PREFERENCES
    : parseChatUserPreferences(candidate.userPreferences);
  if (!preferences) throw new Error("Invalid chat bootstrap response.");

  const modelPreferences: StoredChatModelPreference[] = [];
  for (const value of candidate.modelPreferences) {
    const row = asRecord(value);
    const conversationId = requiredString(row?.conversationId);
    const preference = parseChatModelPreference(row);
    if (conversationId && preference) modelPreferences.push({ conversationId, ...preference });
  }

  const streamingValue = asRecord(candidate.streamingByConversation);
  if (!streamingValue || Object.values(streamingValue).some((value) => value !== "persisted")) {
    throw new Error("Invalid chat bootstrap response.");
  }
  const userId = requiredString(user.id);
  const userEmail = requiredString(user.email);
  if (!userId || !userEmail) throw new Error("Invalid chat bootstrap response.");
  return {
    user: { id: userId, email: userEmail },
    summaries: normalizedSummaries,
    streamingByConversation: streamingValue as Record<string, "persisted">,
    activeConversation,
    activeConversationId,
    requestedConversationId,
    userPreferences: preferences,
    modelPreferences,
  };
}
