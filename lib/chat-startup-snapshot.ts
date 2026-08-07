import type {
  ChatConversation,
  ChatConversationSummary,
  ChatHistoryMessage,
} from "./chat-history";
import { isValidConversationId } from "./chat-conversation-id";
import {
  parseChatModelPreference,
  type ChatModelPreference,
} from "./chat-model-preference";
import type { ChatDocumentAttachment } from "./chat-document";
import type { ChatImageAttachment } from "./chat-image";
import { isChatModelRef, type ChatModelRef } from "./chat-protocol";
import { DEFAULT_AUTOMATION_MODEL } from "./automation-protocol";

export const CHAT_STARTUP_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CHAT_STARTUP_SNAPSHOT_MAX_TURNS = 30;

export type ChatStartupStage = "shell" | "snapshot" | "remote" | "error";

export type ChatStartupSnapshotV1 = {
  schemaVersion: typeof CHAT_STARTUP_SNAPSHOT_SCHEMA_VERSION;
  userId: string;
  savedAt: string;
  summaries: ChatConversationSummary[];
  streamingByConversation: Record<string, "persisted">;
  activeConversation: ChatConversation | null;
  activeConversationId: string | null;
  userPresence: string;
  visionModel: ChatModelRef | null;
  automationModel: ChatModelRef;
  modelPreferences: Array<ChatModelPreference & { conversationId: string }>;
  originalTurnCount: number;
};

export type ChatStartupSnapshotInput = {
  userId: string;
  savedAt?: string;
  summaries: readonly ChatConversationSummary[];
  streamingByConversation: Readonly<Record<string, "persisted">>;
  activeConversation: ChatConversation | null;
  activeConversationId: string | null;
  userPresence: string;
  visionModel?: ChatModelRef | null;
  automationModel?: ChatModelRef;
  modelPreferences: readonly (ChatModelPreference & { conversationId: string })[];
};

export type SnapshotStartupResolution =
  | { type: "cached"; conversation: ChatConversation }
  | { type: "shell" }
  | { type: "create"; conversation: ChatConversation };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : (typeof value === "string" ? value : undefined);
}

function safeValue(value: unknown, key = ""): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (!isRecord(value)) return undefined;

  const blockedKey = /^(accessToken|refreshToken|authorization|session|file|blob|objectUrl|documentContents|rawBytes)$/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !blockedKey.test(name) && name !== key)
      .map(([name, item]) => [name, safeValue(item, name)])
      .filter(([, item]) => item !== undefined),
  );
}

function cloneImageAttachment(value: ChatImageAttachment): ChatImageAttachment {
  return {
    id: value.id,
    name: value.name,
    contentType: value.contentType,
    size: value.size,
    storagePath: value.storagePath,
    analysis: {
      status: value.analysis.status,
      visibleText: value.analysis.visibleText,
      mainVisuals: value.analysis.mainVisuals,
      textModel: value.analysis.textModel,
      visualModel: value.analysis.visualModel,
    },
  };
}

function cloneDocumentAttachment(value: ChatDocumentAttachment): ChatDocumentAttachment {
  // Document page text and embedded-image analyses are deliberately omitted.
  // The transcript only needs the descriptor, and the remote conversation is
  // authoritative once bootstrap completes.
  return {
    id: value.id,
    name: value.name,
    contentType: value.contentType,
    size: value.size,
    pageCount: value.pageCount,
    tokenEstimate: value.tokenEstimate,
    hasImages: value.hasImages,
    imageCount: value.imageCount,
    analyzedImageCount: value.analyzedImageCount,
    imageAnalyses: [],
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.revisionId ? { revisionId: value.revisionId } : {}),
    ...(value.parentRevisionId !== undefined ? { parentRevisionId: value.parentRevisionId } : {}),
    ...(value.origin ? { origin: value.origin } : {}),
    ...(value.editable !== undefined ? { editable: value.editable } : {}),
    ...(value.sourceCompleteness ? { sourceCompleteness: value.sourceCompleteness } : {}),
  };
}

function cloneMessage(value: ChatHistoryMessage): ChatHistoryMessage {
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    ...(value.attachments ? { attachments: value.attachments.map(cloneImageAttachment) } : {}),
    ...(value.documents ? { documents: value.documents.map(cloneDocumentAttachment) } : {}),
    ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
    ...(value.activities ? { activities: safeValue(value.activities) as ChatHistoryMessage["activities"] } : {}),
    ...(value.artifacts ? { artifacts: safeValue(value.artifacts) as ChatHistoryMessage["artifacts"] } : {}),
    ...(value.thinkingEnabled !== undefined ? { thinkingEnabled: value.thinkingEnabled } : {}),
    ...(value.thinkingDurationMs !== undefined ? { thinkingDurationMs: value.thinkingDurationMs } : {}),
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.lastSequence !== undefined ? { lastSequence: value.lastSequence } : {}),
    ...(value.traceRound !== undefined ? { traceRound: value.traceRound } : {}),
    ...(value.tracePhase !== undefined ? { tracePhase: value.tracePhase } : {}),
    ...(value.annotations ? { annotations: safeValue(value.annotations) as ChatHistoryMessage["annotations"] } : {}),
    ...(value.sources ? { sources: safeValue(value.sources) as ChatHistoryMessage["sources"] } : {}),
    ...(value.experimentAssignment ? { experimentAssignment: safeValue(value.experimentAssignment) as ChatHistoryMessage["experimentAssignment"] } : {}),
  };
}

function cloneConversation(value: ChatConversation, maxTurns = Number.POSITIVE_INFINITY): ChatConversation {
  const turns = value.turns.slice(-maxTurns);
  return {
    id: value.id,
    title: value.title,
    turns: turns.map((turn, turnIndex) => ({
      id: turn.id,
      activeVersion: turn.activeVersion,
      versions: turn.versions.map((version) => ({
        id: version.id,
        user: cloneMessage(version.user),
        assistant: cloneMessage(version.assistant),
        ...(turnIndex === 0
          ? { parentVersionId: null }
          : version.parentVersionId !== undefined
          ? { parentVersionId: version.parentVersionId }
          : {}),
      })),
    })),
  };
}

function parseImageAttachment(value: unknown): ChatImageAttachment | null {
  if (!isRecord(value) || typeof value.id !== "string" || (value.name !== null && typeof value.name !== "string")
    || typeof value.contentType !== "string" || typeof value.size !== "number" || !Number.isFinite(value.size)
    || typeof value.storagePath !== "string" || !isRecord(value.analysis)) return null;
  const analysis = value.analysis;
  if ((analysis.status !== "complete" && analysis.status !== "failed")
    || (analysis.visibleText !== null && typeof analysis.visibleText !== "string")
    || (analysis.mainVisuals !== null && typeof analysis.mainVisuals !== "string")
    || (analysis.textModel !== null && typeof analysis.textModel !== "string")
    || (analysis.visualModel !== null && typeof analysis.visualModel !== "string")) return null;
  return {
    id: value.id,
    name: value.name as string | null,
    contentType: value.contentType as ChatImageAttachment["contentType"],
    size: value.size,
    storagePath: value.storagePath,
    analysis: {
      status: analysis.status,
      visibleText: analysis.visibleText as string | null,
      mainVisuals: analysis.mainVisuals as string | null,
      textModel: analysis.textModel as string | null,
      visualModel: analysis.visualModel as string | null,
    },
  };
}

function parseDocumentAttachment(value: unknown): ChatDocumentAttachment | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string"
    || (value.contentType !== "application/pdf" && value.contentType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    || typeof value.size !== "number" || !Number.isFinite(value.size)
    || typeof value.pageCount !== "number" || !Number.isInteger(value.pageCount)
    || typeof value.tokenEstimate !== "number" || !Number.isFinite(value.tokenEstimate)
    || typeof value.hasImages !== "boolean" || typeof value.imageCount !== "number"
    || typeof value.analyzedImageCount !== "number") return null;
  return {
    id: value.id,
    name: value.name,
    contentType: value.contentType,
    size: value.size,
    pageCount: value.pageCount,
    tokenEstimate: value.tokenEstimate,
    hasImages: value.hasImages,
    imageCount: value.imageCount,
    analyzedImageCount: value.analyzedImageCount,
    imageAnalyses: [],
    ...(optionalString(value.projectId) ? { projectId: value.projectId as string } : {}),
    ...(optionalString(value.revisionId) ? { revisionId: value.revisionId as string } : {}),
    ...(value.parentRevisionId === null || typeof value.parentRevisionId === "string"
      ? { parentRevisionId: value.parentRevisionId as string | null | undefined } : {}),
    ...(value.origin === "generated" || value.origin === "uploaded" ? { origin: value.origin } : {}),
    ...(typeof value.editable === "boolean" ? { editable: value.editable } : {}),
    ...(value.sourceCompleteness === "complete" || value.sourceCompleteness === "entrypoint-only"
      ? { sourceCompleteness: value.sourceCompleteness } : {}),
  };
}

function parseMessage(value: unknown): ChatHistoryMessage | null {
  const id = isRecord(value) ? requiredString(value.id) : null;
  if (!isRecord(value) || !id
    || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return null;
  if (value.attachments !== undefined && (!Array.isArray(value.attachments)
    || value.attachments.some((attachment) => !parseImageAttachment(attachment)))) return null;
  if (value.documents !== undefined && (!Array.isArray(value.documents)
    || value.documents.some((document) => !parseDocumentAttachment(document)))) return null;
  const message: ChatHistoryMessage = {
    id,
    role: value.role,
    content: value.content,
  };
  if (value.attachments) message.attachments = value.attachments.map((attachment) => parseImageAttachment(attachment)!).map(cloneImageAttachment);
  if (value.documents) message.documents = value.documents.map((document) => parseDocumentAttachment(document)!).map(cloneDocumentAttachment);
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "string") return null;
    message.reasoning = value.reasoning;
  }
  if (value.activities !== undefined) {
    if (!Array.isArray(value.activities)) return null;
    message.activities = safeValue(value.activities) as ChatHistoryMessage["activities"];
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return null;
    message.artifacts = safeValue(value.artifacts) as ChatHistoryMessage["artifacts"];
  }
  if (value.annotations !== undefined) {
    if (!Array.isArray(value.annotations)) return null;
    message.annotations = safeValue(value.annotations) as ChatHistoryMessage["annotations"];
  }
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources)) return null;
    message.sources = safeValue(value.sources) as ChatHistoryMessage["sources"];
  }
  if (value.experimentAssignment !== undefined) {
    if (!isRecord(value.experimentAssignment)) return null;
    message.experimentAssignment = safeValue(value.experimentAssignment) as ChatHistoryMessage["experimentAssignment"];
  }
  if (value.thinkingEnabled !== undefined && typeof value.thinkingEnabled !== "boolean") return null;
  if (value.thinkingDurationMs !== undefined && typeof value.thinkingDurationMs !== "number") return null;
  if (value.status !== undefined && !["streaming", "complete", "error", "cancelled"].includes(value.status as string)) return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  if (value.lastSequence !== undefined && typeof value.lastSequence !== "number") return null;
  if (value.traceRound !== undefined && typeof value.traceRound !== "number") return null;
  if (value.tracePhase !== undefined && typeof value.tracePhase !== "number") return null;
  if (value.thinkingEnabled !== undefined) message.thinkingEnabled = value.thinkingEnabled;
  if (value.thinkingDurationMs !== undefined) message.thinkingDurationMs = value.thinkingDurationMs;
  if (value.status !== undefined) message.status = value.status as ChatHistoryMessage["status"];
  if (value.error !== undefined) message.error = value.error;
  if (value.lastSequence !== undefined) message.lastSequence = value.lastSequence;
  if (value.traceRound !== undefined) message.traceRound = value.traceRound;
  if (value.tracePhase !== undefined) message.tracePhase = value.tracePhase;
  return message;
}

function parseConversation(value: unknown): ChatConversation | null {
  const id = isRecord(value) ? requiredString(value.id) : null;
  if (!isRecord(value) || !id || typeof value.title !== "string" || !Array.isArray(value.turns)) return null;
  const turns = [];
  for (const rawTurn of value.turns) {
    const turnId = isRecord(rawTurn) ? requiredString(rawTurn.id) : null;
    const activeVersion = isRecord(rawTurn) && typeof rawTurn.activeVersion === "number"
      ? rawTurn.activeVersion
      : null;
    if (!isRecord(rawTurn) || !turnId || !Array.isArray(rawTurn.versions)
      || activeVersion === null || !Number.isInteger(activeVersion)) return null;
    const versions = [];
    for (const rawVersion of rawTurn.versions) {
      const versionId = isRecord(rawVersion) ? requiredString(rawVersion.id) : null;
      if (!isRecord(rawVersion) || !versionId) return null;
      const user = parseMessage(rawVersion.user);
      const assistant = parseMessage(rawVersion.assistant);
      if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") return null;
      versions.push({
        id: versionId,
        user,
        assistant,
        ...(typeof rawVersion.parentVersionId === "string" || rawVersion.parentVersionId === null
          ? { parentVersionId: rawVersion.parentVersionId }
          : {}),
      });
    }
    if (!versions.length || activeVersion < 0 || activeVersion >= versions.length) return null;
    turns.push({ id: turnId, versions, activeVersion });
  }
  return { id, title: value.title, turns };
}

function parseSummary(value: unknown): ChatConversationSummary | null {
  const id = isRecord(value) ? requiredString(value.id) : null;
  if (!isRecord(value) || !id || typeof value.title !== "string"
    || typeof value.updatedAt !== "string" || typeof value.hasMessages !== "boolean"
    || typeof value.isStreaming !== "boolean") return null;
  return {
    id,
    title: value.title,
    updatedAt: value.updatedAt,
    hasMessages: value.hasMessages,
    isStreaming: value.isStreaming,
  };
}

export function parseChatStartupSnapshot(value: unknown, expectedUserId: string): ChatStartupSnapshotV1 | null {
  const savedAt = isRecord(value) && typeof value.savedAt === "string" ? value.savedAt : null;
  const userPresence = isRecord(value) && typeof value.userPresence === "string" ? value.userPresence : null;
  const visionModel = isRecord(value) && (value.visionModel === null || value.visionModel === undefined || isChatModelRef(value.visionModel)) ? (value.visionModel ?? null) as ChatModelRef | null : null;
  const automationModel = isRecord(value) && isChatModelRef(value.automationModel) ? value.automationModel : DEFAULT_AUTOMATION_MODEL;
  const originalTurnCount = isRecord(value) && typeof value.originalTurnCount === "number"
    ? value.originalTurnCount
    : null;
  if (!isRecord(value) || value.schemaVersion !== CHAT_STARTUP_SNAPSHOT_SCHEMA_VERSION
    || value.userId !== expectedUserId || savedAt === null
    || !Array.isArray(value.summaries) || !Array.isArray(value.modelPreferences)
    || userPresence === null || userPresence.length > 12_000
    || (value.visionModel !== undefined && !isChatModelRef(value.visionModel) && value.visionModel !== null)
    || originalTurnCount === null || !Number.isInteger(originalTurnCount) || originalTurnCount < 0) return null;

  const summaries = value.summaries.map(parseSummary);
  if (summaries.some((summary) => summary === null)) return null;
  const streaming = value.streamingByConversation;
  if (!isRecord(streaming) || Object.values(streaming).some((status) => status !== "persisted")) return null;
  const modelPreferences = value.modelPreferences.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.conversationId !== "string") return null;
    const preference = parseChatModelPreference(candidate);
    return preference ? { conversationId: candidate.conversationId, ...preference } : null;
  });
  if (modelPreferences.some((preference) => preference === null)) return null;

  const activeConversation = value.activeConversation === null ? null : parseConversation(value.activeConversation);
  if (value.activeConversation !== null && !activeConversation) return null;
  const activeConversationId = value.activeConversationId === null
    ? null
    : requiredString(value.activeConversationId);
  if (value.activeConversationId !== null && !activeConversationId) return null;
  if (activeConversation && activeConversationId !== activeConversation.id) return null;
  if (activeConversation && activeConversation.turns.length > originalTurnCount) return null;

  return {
    schemaVersion: CHAT_STARTUP_SNAPSHOT_SCHEMA_VERSION,
    userId: expectedUserId,
    savedAt,
    summaries: summaries as ChatConversationSummary[],
    streamingByConversation: { ...streaming } as Record<string, "persisted">,
    activeConversation,
    activeConversationId,
    userPresence,
    visionModel,
    automationModel,
    modelPreferences: modelPreferences as Array<ChatModelPreference & { conversationId: string }>,
    originalTurnCount,
  };
}

export function createChatStartupSnapshot(input: ChatStartupSnapshotInput): ChatStartupSnapshotV1 {
  const activeConversation = input.activeConversation
    ? cloneConversation(input.activeConversation, CHAT_STARTUP_SNAPSHOT_MAX_TURNS)
    : null;
  return {
    schemaVersion: CHAT_STARTUP_SNAPSHOT_SCHEMA_VERSION,
    userId: input.userId,
    savedAt: input.savedAt ?? new Date().toISOString(),
    summaries: input.summaries.map(({ id, title, updatedAt, hasMessages, isStreaming }) => ({
      id,
      title,
      updatedAt,
      hasMessages,
      isStreaming,
    })),
    streamingByConversation: Object.fromEntries(
      Object.entries(input.streamingByConversation).filter(([, status]) => status === "persisted"),
    ),
    activeConversation,
    activeConversationId: activeConversation?.id ?? input.activeConversationId,
    userPresence: input.userPresence,
    visionModel: input.visionModel ?? null,
    automationModel: input.automationModel ?? DEFAULT_AUTOMATION_MODEL,
    modelPreferences: input.modelPreferences.flatMap(({ conversationId, ...preference }) => {
      const parsed = parseChatModelPreference(preference);
      return parsed ? [{ conversationId, ...parsed }] : [];
    }),
    originalTurnCount: input.activeConversation?.turns.length ?? 0,
  };
}

export function resolveSnapshotStartup(
  snapshot: ChatStartupSnapshotV1 | null,
  requestedConversationId?: string,
): SnapshotStartupResolution {
  const requestedId = requestedConversationId?.trim() || undefined;
  if (!snapshot) {
    return isValidConversationId(requestedId)
      ? { type: "create", conversation: { id: requestedId, title: "New conversation", turns: [] } }
      : { type: "shell" };
  }
  if (!requestedId) {
    return snapshot.activeConversation
      ? { type: "cached", conversation: snapshot.activeConversation }
      : { type: "shell" };
  }
  if (isValidConversationId(requestedId) && snapshot.activeConversation?.id === requestedId) {
    return { type: "cached", conversation: snapshot.activeConversation };
  }
  if (snapshot.summaries.some(({ id }) => id === requestedId)) return { type: "shell" };
  return isValidConversationId(requestedId)
    ? { type: "create", conversation: { id: requestedId, title: "New conversation", turns: [] } }
    : { type: "shell" };
}
