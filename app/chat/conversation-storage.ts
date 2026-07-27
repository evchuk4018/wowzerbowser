import type {
  ChatArtifact,
  ChatToolCall,
  ChatToolResult,
} from "../../lib/chat-protocol";
import { normalizeChatImageAttachments, parseChatImageToolResult } from "../../lib/chat-protocol";
import type { ChatAssistantActivity } from "../../lib/chat-history";
import { DOCUMENT_CONTENT_TYPES, type ChatDocumentAttachment } from "../../lib/chat-document";
import { sourceForUrl } from "../../lib/chat-citations";
import {
  deleteChatConversation,
  fetchChatConversation,
  fetchChatConversations,
  updateChatConversation,
} from "./chat-service";
import {
  fetchChatUserPreferences,
  saveChatUserPreferences,
} from "./chat-user-preferences-service";
import {
  DEFAULT_CHAT_SETTINGS,
  makeId,
} from "./conversation-defaults";
import type {
  ChatSettings,
  Conversation,
  ConversationTurn,
  Message,
  TurnVersion,
} from "./conversation-types";
import {
  DEFAULT_CHAT_USER_PREFERENCES,
  parseChatUserPreferences,
} from "../../lib/chat-user-preferences";

/** The result used by the workspace when hydrating remote conversation history. */
export type LoadedConversations = {
  conversations: Conversation[];
  streamingByConversation: Record<string, string>;
};

type RecordValue = Record<string, unknown>;

const MESSAGE_STATUSES = new Set(["streaming", "complete", "error", "cancelled"]);
const ACTIVITY_STATUSES = new Set(["running", "complete", "completed", "failed"]);

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeDocumentAttachment(value: unknown): ChatDocumentAttachment | null {
  const candidate = asRecord(value);
  if (!candidate || typeof candidate.id !== "string" || !candidate.id
    || typeof candidate.name !== "string"
    || !DOCUMENT_CONTENT_TYPES.includes(candidate.contentType as never)
    || typeof candidate.size !== "number" || !Number.isFinite(candidate.size) || candidate.size < 0
    || typeof candidate.pageCount !== "number" || !Number.isFinite(candidate.pageCount) || candidate.pageCount < 0
    || typeof candidate.tokenEstimate !== "number" || !Number.isFinite(candidate.tokenEstimate) || candidate.tokenEstimate < 0) return null;
  const legacyPdf = candidate.contentType === "application/pdf";
  const hasImages = typeof candidate.hasImages === "boolean" ? candidate.hasImages : false;
  const imageCount = typeof candidate.imageCount === "number" && Number.isFinite(candidate.imageCount) ? Math.max(0, candidate.imageCount) : 0;
  const analyzedImageCount = typeof candidate.analyzedImageCount === "number" && Number.isFinite(candidate.analyzedImageCount) ? Math.max(0, candidate.analyzedImageCount) : 0;
  const imageAnalyses = Array.isArray(candidate.imageAnalyses) ? candidate.imageAnalyses : [];
  if (!legacyPdf && typeof candidate.hasImages !== "boolean") return null;
  return {
    id: candidate.id,
    name: candidate.name,
    contentType: candidate.contentType as ChatDocumentAttachment["contentType"],
    size: candidate.size,
    pageCount: candidate.pageCount,
    tokenEstimate: candidate.tokenEstimate,
    hasImages,
    imageCount,
    analyzedImageCount,
    imageAnalyses: imageAnalyses as ChatDocumentAttachment["imageAnalyses"],
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function normalizeArtifact(value: unknown): ChatArtifact | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const name = typeof candidate.name === "string" ? candidate.name : null;
  const contentType = typeof candidate.contentType === "string" ? candidate.contentType : null;
  const size = nonNegativeNumber(candidate.size);
  if (!id || name === null || contentType === null || size === undefined) return null;
  return { id, name, contentType, size };
}

function normalizeToolCall(value: unknown): ChatToolCall | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const name = nonEmptyString(candidate.name);
  const args = typeof candidate.arguments === "string" ? candidate.arguments : null;
  if (!id || !name || args === null) return null;
  return { id, name, arguments: args };
}

function normalizeToolResult(value: unknown): ChatToolResult | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  const id = nonEmptyString(candidate.id);
  const name = nonEmptyString(candidate.name);
  const stdout = typeof candidate.stdout === "string" ? candidate.stdout : null;
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : null;
  if (!id || !name || stdout === null || stderr === null || typeof candidate.ok !== "boolean") {
    return undefined;
  }
  const result: ChatToolResult = {
    id,
    name,
    ok: candidate.ok,
    stdout,
    stderr,
  };
  const exitCode = finiteNumber(candidate.exitCode);
  const durationMs = nonNegativeNumber(candidate.durationMs);
  if (exitCode !== undefined) result.exitCode = exitCode;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (typeof candidate.timedOut === "boolean") result.timedOut = candidate.timedOut;
  if (typeof candidate.stdoutTruncated === "boolean") result.stdoutTruncated = candidate.stdoutTruncated;
  if (typeof candidate.stderrTruncated === "boolean") result.stderrTruncated = candidate.stderrTruncated;
  if (Array.isArray(candidate.artifacts)) {
    result.artifacts = candidate.artifacts
      .map(normalizeArtifact)
      .filter((artifact): artifact is ChatArtifact => artifact !== null);
  }
  // The provider payload is deliberately kept opaque here.  It is validated by
  // the protocol layer when it is used, while malformed values are ignored.
  if (candidate.web && typeof candidate.web === "object") {
    const web = candidate.web as Record<string, unknown>;
    if (web.kind === "page" && typeof web.url === "string" && typeof web.markdown === "string") {
      result.web = { kind: "page", source: sourceForUrl({ url: web.url, snippet: web.markdown.slice(0, 1200) }), markdown: web.markdown };
    } else result.web = candidate.web as ChatToolResult["web"];
  }
  if (candidate.utility && typeof candidate.utility === "object") result.utility = candidate.utility as ChatToolResult["utility"];
  if (candidate.image && typeof candidate.image === "object") {
    try { result.image = parseChatImageToolResult(candidate.image); } catch { /* malformed legacy activity */ }
  }
  return result;
}

function normalizeActivity(value: unknown, loadedAt: number, freezeRunning: boolean): ChatAssistantActivity | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const round = finiteNumber(candidate.round);
  const status = typeof candidate.status === "string" && ACTIVITY_STATUSES.has(candidate.status)
    ? candidate.status
    : null;
  const startedAt = nonNegativeNumber(candidate.startedAt);
  const durationMs = nonNegativeNumber(candidate.durationMs);
  if (!id || round === undefined || !status) return null;

  if (candidate.kind === "reasoning") {
    if (typeof candidate.content !== "string" || (status !== "running" && status !== "complete")) return null;
    const activity: ChatAssistantActivity = {
      id,
      kind: "reasoning",
      round,
      content: candidate.content,
      status,
    };
    if (startedAt !== undefined) activity.startedAt = startedAt;
    if (durationMs !== undefined) activity.durationMs = durationMs;
    if (freezeRunning && activity.status === "running") {
      activity.status = "complete";
      activity.durationMs = durationMs ?? (startedAt === undefined ? undefined : Math.max(0, loadedAt - startedAt));
    }
    return activity;
  }

  if (candidate.kind !== "python" && candidate.kind !== "web" && candidate.kind !== "image") return null;
  const call = normalizeToolCall(candidate.call);
  if (!call || (status !== "running" && status !== "completed" && status !== "failed")) return null;
  const activity: Extract<ChatAssistantActivity, { kind: "python" | "web" | "image" }> = {
    id,
    kind: candidate.kind,
    round,
    call,
    status,
  };
  const result = normalizeToolResult(candidate.result);
  if (result) activity.result = result;
  if (startedAt !== undefined) activity.startedAt = startedAt;
  if (durationMs !== undefined) activity.durationMs = durationMs;
  if (freezeRunning && activity.status === "running") {
    activity.status = "failed";
    activity.durationMs = durationMs ?? (startedAt === undefined ? undefined : Math.max(0, loadedAt - startedAt));
  }
  return activity;
}

/**
 * Validate and normalize one persisted message without mutating the input.
 *
 * Running activities from legacy browser data are frozen because that tab no
 * longer exists. Remote history can opt out of that behavior while a durable
 * job is being recovered via `normalizeConversation`'s options.
 */
export function normalizeStoredMessage(
  value: unknown,
  options: { freezeRunningActivities?: boolean; now?: number } = {},
): Message | null {
  const candidate = asRecord(value);
  if (!candidate || (candidate.role !== "user" && candidate.role !== "assistant")) return null;
  const id = nonEmptyString(candidate.id);
  if (!id || typeof candidate.content !== "string") return null;
  const message = {
    id,
    role: candidate.role,
    content: candidate.content,
  } as Message;
  if (typeof candidate.reasoning === "string") message.reasoning = candidate.reasoning;
  if (typeof candidate.thinkingEnabled === "boolean") message.thinkingEnabled = candidate.thinkingEnabled;
  if (typeof candidate.thinkingDurationMs === "number" && Number.isFinite(candidate.thinkingDurationMs)) {
    message.thinkingDurationMs = Math.max(0, candidate.thinkingDurationMs);
  }
  if (typeof candidate.status === "string" && MESSAGE_STATUSES.has(candidate.status)) {
    message.status = candidate.status as Message["status"];
  }
  if (typeof candidate.error === "string") message.error = candidate.error;
  if (typeof candidate.jobId === "string" && candidate.jobId.length > 0) message.jobId = candidate.jobId;
  const lastSequence = finiteNumber(candidate.lastSequence);
  if (lastSequence !== undefined && lastSequence >= 0) message.lastSequence = lastSequence;
  const traceRound = finiteNumber(candidate.traceRound);
  if (traceRound !== undefined && traceRound >= 0) message.traceRound = traceRound;
  if (Array.isArray(candidate.annotations)) message.annotations = candidate.annotations as Message["annotations"];
  if (Array.isArray(candidate.sources)) message.sources = candidate.sources as Message["sources"];
  if (Array.isArray(candidate.attachments)) {
    const attachments = normalizeChatImageAttachments(candidate.attachments);
    if (attachments.length) message.attachments = attachments;
  }
  if (Array.isArray(candidate.documents)) {
    const documents = candidate.documents
      .map(normalizeDocumentAttachment)
      .filter((document): document is ChatDocumentAttachment => document !== null);
    if (documents.length) message.documents = documents;
  }
  if (Array.isArray(candidate.artifacts)) {
    message.artifacts = candidate.artifacts
      .map(normalizeArtifact)
      .filter((artifact): artifact is ChatArtifact => artifact !== null);
  }
  if (Array.isArray(candidate.activities)) {
    const now = options.now ?? Date.now();
    message.activities = candidate.activities
      .map((activity) => normalizeActivity(activity, now, options.freezeRunningActivities ?? true))
      .filter((activity): activity is ChatAssistantActivity => activity !== null);
  }
  return message;
}

function normalizeTurnVersion(value: unknown, options: { freezeRunningActivities?: boolean; now?: number } = {}): TurnVersion | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const user = normalizeStoredMessage(candidate.user, options);
  const assistant = normalizeStoredMessage(candidate.assistant, options);
  if (!id || !user || user.role !== "user" || !assistant || assistant.role !== "assistant") return null;
  return { id, user, assistant };
}

function normalizeTurn(value: unknown, options: { freezeRunningActivities?: boolean; now?: number } = {}): ConversationTurn | null {
  const candidate = asRecord(value);
  if (!candidate || !Array.isArray(candidate.versions)) return null;
  const id = nonEmptyString(candidate.id);
  if (!id) return null;
  const versions = candidate.versions
    .map((version) => normalizeTurnVersion(version, options))
    .filter((version): version is TurnVersion => version !== null);
  if (!versions.length) return null;
  const activeVersion = finiteNumber(candidate.activeVersion);
  return {
    id,
    versions,
    activeVersion: activeVersion !== undefined && activeVersion >= 0
      ? Math.min(Math.floor(activeVersion), versions.length - 1)
      : 0,
  };
}

/** Normalize a current or legacy conversation payload. */
export function normalizeConversation(
  value: unknown,
  options: { freezeRunningActivities?: boolean; now?: number } = {},
): Conversation | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const title = typeof candidate.title === "string" ? candidate.title : null;
  if (!id || title === null) return null;
  if (Array.isArray(candidate.turns)) {
    const turns = candidate.turns
      .map((turn) => normalizeTurn(turn, options))
      .filter((turn): turn is ConversationTurn => turn !== null);
    return { id, title, turns };
  }
  // The first client stored a flat alternating messages array. Convert pairs
  // without ever reading from or writing to browser storage.
  if (!Array.isArray(candidate.messages)) return null;
  const turns: ConversationTurn[] = [];
  for (let index = 0; index + 1 < candidate.messages.length; index += 2) {
    const user = normalizeStoredMessage(candidate.messages[index], { ...options, freezeRunningActivities: true });
    const assistant = normalizeStoredMessage(candidate.messages[index + 1], { ...options, freezeRunningActivities: true });
    if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") continue;
    turns.push({
      id: makeId(),
      versions: [{ id: makeId(), user, assistant }],
      activeVersion: 0,
    });
  }
  return { id, title, turns };
}

/** Backward-compatible name for callers migrating old flat conversations. */
export const migrateConversation = normalizeConversation;

function validSummary(value: unknown): { id: string; isStreaming: boolean } | null {
  const candidate = asRecord(value);
  const id = nonEmptyString(candidate?.id);
  if (!id) return null;
  return { id, isStreaming: candidate?.isStreaming === true };
}

/**
 * Load remote history and retain only valid records. A failed detail request
 * does not discard conversations that loaded successfully; a failed list
 * request returns an empty result so the workspace can create a blank chat.
 */
export async function loadConversations(accessToken: string): Promise<LoadedConversations> {
  try {
    const rawSummaries = await fetchChatConversations(accessToken);
    if (!Array.isArray(rawSummaries)) return { conversations: [], streamingByConversation: {} };
    const summaries = rawSummaries
      .map(validSummary)
      .filter((summary): summary is { id: string; isStreaming: boolean } => summary !== null);
    const loaded = await Promise.allSettled(
      summaries.map(async (summary) => normalizeConversation(
        await fetchChatConversation(summary.id, accessToken),
        { freezeRunningActivities: false },
      )),
    );
    const conversations: Conversation[] = [];
    const seen = new Set<string>();
    loaded.forEach((result) => {
      if (result.status !== "fulfilled" || !result.value || seen.has(result.value.id)) return;
      seen.add(result.value.id);
      conversations.push(result.value);
    });
    const streamingByConversation: Record<string, string> = {};
    summaries.forEach((summary) => {
      if (summary.isStreaming && seen.has(summary.id)) streamingByConversation[summary.id] = "persisted";
    });
    return { conversations, streamingByConversation };
  } catch {
    return { conversations: [], streamingByConversation: {} };
  }
}

/** Save server-owned conversation metadata. Transcript writes happen in jobs. */
export async function saveConversation(
  conversation: Conversation,
  accessToken: string,
): Promise<void> {
  if (!conversation || typeof conversation.id !== "string" || !conversation.id) return;
  try {
    await updateChatConversation(conversation.id, { title: conversation.title }, accessToken);
  } catch {
    // Persistence is best effort at the UI boundary; the local reducer remains authoritative.
  }
}

export async function deleteConversation(
  conversationId: string,
  accessToken: string,
): Promise<void> {
  if (!conversationId) return;
  await deleteChatConversation(conversationId, accessToken);
}

export async function saveConversationSelection(
  conversationId: string,
  turnId: string,
  versionId: string,
  accessToken: string,
): Promise<void> {
  if (!conversationId || !turnId || !versionId) return;
  try {
    await updateChatConversation(conversationId, { turnId, versionId }, accessToken);
  } catch {
    // See saveConversation: a transient metadata failure must not break chat UI.
  }
}

/** Load user preferences while always retaining the canonical system prompt. */
export async function loadSettings(accessToken: string): Promise<ChatSettings> {
  try {
    const value = await fetchChatUserPreferences(accessToken);
    const parsed = parseChatUserPreferences(value) ?? DEFAULT_CHAT_USER_PREFERENCES;
    return { ...DEFAULT_CHAT_SETTINGS, userPresence: parsed.userPresence };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

/** Save the remotely supported user preference; systemPrompt is canonical. */
export async function saveSettings(settings: ChatSettings, accessToken: string): Promise<void> {
  const userPresence = typeof settings?.userPresence === "string"
    ? settings.userPresence.trim().slice(0, 12_000)
    : "";
  try {
    await saveChatUserPreferences({ userPresence }, accessToken);
  } catch {
    // Saving preferences is intentionally nonfatal, matching the existing UI policy.
  }
}
