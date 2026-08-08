import type {
  ChatArtifact,
  ChatToolCall,
  ChatToolResult,
} from "../../lib/chat-protocol";
import {
  normalizeChatImageAttachments,
  normalizeChatResearchTrace,
  parseChatImageToolResult,
} from "../../lib/chat-protocol";
import type {
  ChatAssistantActivity,
  ChatConversation,
  ChatConversationSummary,
  ChatResearchSummaryRevision,
} from "../../lib/chat-history";
import { DOCUMENT_CONTENT_TYPES, type ChatDocumentAttachment } from "../../lib/chat-document";
import { CHAT_SOURCE_SNIPPET_MAX_LENGTH, sourceForUrl } from "../../lib/chat-citations";
import { normalizeTodoList } from "../../lib/todo-protocol";
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

export type LoadedConversationIndex = {
  summaries: ChatConversationSummary[];
  streamingByConversation: Record<string, string>;
};

type RecordValue = Record<string, unknown>;

const MESSAGE_STATUSES = new Set(["streaming", "complete", "error", "cancelled"]);
const ACTIVITY_STATUSES = new Set(["running", "complete", "completed", "failed"]);
const MAX_RESEARCH_SUMMARY_LENGTH = 4_000;
const MAX_RESEARCH_SUMMARY_HISTORY = 128;

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
    ...(typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {}),
    ...(typeof candidate.revisionId === "string" ? { revisionId: candidate.revisionId } : {}),
    ...(candidate.parentRevisionId === null || typeof candidate.parentRevisionId === "string" ? { parentRevisionId: candidate.parentRevisionId as string | null } : {}),
    ...(candidate.origin === "generated" || candidate.origin === "uploaded" ? { origin: candidate.origin } : {}),
    ...(typeof candidate.editable === "boolean" ? { editable: candidate.editable } : {}),
    ...(candidate.sourceCompleteness === "complete" || candidate.sourceCompleteness === "entrypoint-only" ? { sourceCompleteness: candidate.sourceCompleteness } : {}),
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
  return { id, name, contentType, size,
    ...(typeof candidate.sha256 === "string" && /^[0-9a-f]{64}$/i.test(candidate.sha256) ? { sha256: candidate.sha256.toLowerCase() } : {}),
    ...(typeof candidate.workspacePath === "string" ? { workspacePath: candidate.workspacePath } : {}),
    ...(typeof candidate.language === "string" ? { language: candidate.language } : {}),
    ...(candidate.preview === "html" || candidate.preview === "markdown" || candidate.preview === "svg" || candidate.preview === "image" || candidate.preview === "text" || candidate.preview === "none" ? { preview: candidate.preview } : {}),
    ...(typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {}),
    ...(typeof candidate.revisionId === "string" ? { revisionId: candidate.revisionId } : {}),
    ...(candidate.parentRevisionId === null || typeof candidate.parentRevisionId === "string" ? { parentRevisionId: candidate.parentRevisionId as string | null } : {}),
    ...(candidate.origin === "generated" || candidate.origin === "uploaded" ? { origin: candidate.origin } : {}),
    ...(typeof candidate.editable === "boolean" ? { editable: candidate.editable } : {}),
    ...(candidate.sourceCompleteness === "complete" || candidate.sourceCompleteness === "entrypoint-only" ? { sourceCompleteness: candidate.sourceCompleteness } : {}),
  };
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
      result.web = { kind: "page", source: sourceForUrl({ url: web.url, snippet: web.markdown.slice(0, CHAT_SOURCE_SNIPPET_MAX_LENGTH) }), markdown: web.markdown };
    } else result.web = candidate.web as ChatToolResult["web"];
  }
  if (candidate.utility && typeof candidate.utility === "object") result.utility = candidate.utility as ChatToolResult["utility"];
  if (candidate.image && typeof candidate.image === "object") {
    try { result.image = parseChatImageToolResult(candidate.image); } catch { /* malformed legacy activity */ }
  }
  return result;
}

function normalizeResearchSummaryHistory(value: unknown): ChatResearchSummaryRevision[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  return value.slice(0, MAX_RESEARCH_SUMMARY_HISTORY).flatMap((item, index) => {
    const candidate = asRecord(item);
    const revision = candidate ? finiteNumber(candidate.revision) : typeof item === "string" ? index : undefined;
    const summary = candidate
      ? typeof candidate.summary === "string" ? candidate.summary : undefined
      : typeof item === "string" ? item : undefined;
    if (revision === undefined || !Number.isInteger(revision) || revision < 0 || summary === undefined || seen.has(revision)) return [];
    seen.add(revision);
    return [{ revision, summary: summary.slice(0, MAX_RESEARCH_SUMMARY_LENGTH) }];
  });
}

function normalizeActivity(value: unknown, loadedAt: number, freezeRunning: boolean): ChatAssistantActivity | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const id = nonEmptyString(candidate.id);
  const round = finiteNumber(candidate.round);
  const phase = finiteNumber(candidate.phase) ?? 1;
  const startedAt = nonNegativeNumber(candidate.startedAt);
  const durationMs = nonNegativeNumber(candidate.durationMs);
  if (!id || round === undefined) return null;

  if (candidate.kind === "subagent") {
    const taskId = nonEmptyString(candidate.taskId);
    const title = nonEmptyString(candidate.title);
    const status = candidate.status === "queued" || candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed"
      ? candidate.status
      : null;
    if (!taskId || !title || !status) return null;
    const activity: Extract<ChatAssistantActivity, { kind: "subagent" }> = {
      id,
      kind: "subagent",
      round,
      phase,
      taskId,
      title: title.slice(0, MAX_RESEARCH_SUMMARY_LENGTH),
      status,
    };
    if (typeof candidate.summary === "string") activity.summary = candidate.summary.slice(0, MAX_RESEARCH_SUMMARY_LENGTH);
    let summaryHistory = normalizeResearchSummaryHistory(candidate.summaryHistory);
    const summaryRevision = finiteNumber(candidate.summaryRevision);
    if (summaryHistory.length === 0 && summaryRevision !== undefined && Number.isInteger(summaryRevision) && summaryRevision >= 0 && activity.summary !== undefined) {
      summaryHistory = [{ revision: summaryRevision, summary: activity.summary }];
    }
    if (summaryHistory.length) activity.summaryHistory = summaryHistory;
    const trace = normalizeChatResearchTrace(candidate.trace);
    if (trace.length) activity.trace = trace;
    if (startedAt !== undefined) activity.startedAt = startedAt;
    if (durationMs !== undefined) activity.durationMs = durationMs;
    if (freezeRunning && (activity.status === "running" || activity.status === "queued")) {
      activity.status = "failed";
      activity.durationMs = durationMs ?? (startedAt === undefined ? undefined : Math.max(0, loadedAt - startedAt));
    }
    return activity;
  }

  const status = typeof candidate.status === "string" && ACTIVITY_STATUSES.has(candidate.status)
    ? candidate.status
    : null;
  if (!status) return null;

  if (candidate.kind === "reasoning") {
    if (typeof candidate.content !== "string" || (status !== "running" && status !== "complete")) return null;
    const activity: Extract<ChatAssistantActivity, { kind: "reasoning" }> = {
      id,
      kind: "reasoning",
      round,
      phase,
      content: candidate.content,
      status,
    };
    if (typeof candidate.summary === "string" && candidate.summary.trim()) activity.summary = candidate.summary.trim();
    const summaryRevision = finiteNumber(candidate.summaryRevision);
    if (summaryRevision !== undefined) activity.summaryRevision = summaryRevision;
    const trace = normalizeChatResearchTrace(candidate.trace);
    if (trace.length) activity.trace = trace;
    if (startedAt !== undefined) activity.startedAt = startedAt;
    if (durationMs !== undefined) activity.durationMs = durationMs;
    if (freezeRunning && activity.status === "running") {
      activity.status = "complete";
      activity.durationMs = durationMs ?? (startedAt === undefined ? undefined : Math.max(0, loadedAt - startedAt));
    }
    return activity;
  }

  if (candidate.kind === "output") {
    if (typeof candidate.content !== "string" || status !== "complete") return null;
    return {
      id,
      kind: "output",
      round,
      phase,
      content: candidate.content,
      status: "complete",
    };
  }

  if (candidate.kind === "phase_break") {
    const call = normalizeToolCall(candidate.call);
    const result = normalizeToolResult(candidate.result);
    const nextPhase = finiteNumber(candidate.nextPhase);
    if (!call || !result || nextPhase === undefined) return null;
    return {
      id,
      kind: "phase_break",
      round,
      phase,
      nextPhase,
      ...(typeof candidate.update === "string" && candidate.update.trim() ? { update: candidate.update.trim() } : {}),
      call,
      result,
      status: "completed",
    };
  }

  if (candidate.kind !== "python" && candidate.kind !== "web" && candidate.kind !== "image" && candidate.kind !== "document" && candidate.kind !== "subagent_tool") return null;
  const call = normalizeToolCall(candidate.call);
  if (!call || (status !== "running" && status !== "completed" && status !== "failed")) return null;
  const activity: Extract<ChatAssistantActivity, { kind: "python" | "web" | "image" | "document" | "subagent_tool" }> = {
    id,
    kind: candidate.kind,
    round,
    phase,
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
  if (candidate.role === "assistant") {
    const comparison = asRecord(candidate.abTestComparison);
    const options = asRecord(comparison?.options);
    const optionA = asRecord(options?.a);
    const optionB = asRecord(options?.b);
    const selected = comparison?.selected === null || comparison?.selected === "a" || comparison?.selected === "b"
      ? comparison.selected
      : undefined;
    const comparisonId = nonEmptyString(comparison?.id);
    const trialId = nonEmptyString(comparison?.trialId);
    const turnId = nonEmptyString(comparison?.turnId);
    const responseA = nonEmptyString(optionA?.responseId);
    const responseB = nonEmptyString(optionB?.responseId);
    if (
      comparison
      && options
      && (comparison.status === "pending" || comparison.status === "voted")
      && (comparison.variantKey === "a" || comparison.variantKey === "b")
      && (comparison.displayAVariant === "a" || comparison.displayAVariant === "b")
      && selected !== undefined
      && comparisonId
      && trialId
      && turnId
      && responseA
      && responseB
    ) {
      message.abTestComparison = {
        id: comparisonId,
        trialId,
        turnId,
        displayAVariant: comparison.displayAVariant,
        options: {
          a: { responseId: responseA },
          b: { responseId: responseB },
        },
        status: comparison.status,
        selected,
        variantKey: comparison.variantKey,
      };
    }
  }
  if (candidate.todos && typeof candidate.todos === "object") message.todos = normalizeTodoList(candidate.todos);
  if (candidate.deepResearchPlan && typeof candidate.deepResearchPlan === "object") message.deepResearchPlan = candidate.deepResearchPlan as Message["deepResearchPlan"];
  if (typeof candidate.jobId === "string" && candidate.jobId.length > 0) message.jobId = candidate.jobId;
  const lastSequence = finiteNumber(candidate.lastSequence);
  if (lastSequence !== undefined && lastSequence >= 0) message.lastSequence = lastSequence;
  const traceRound = finiteNumber(candidate.traceRound);
  if (traceRound !== undefined && traceRound >= 0) message.traceRound = traceRound;
  const tracePhase = finiteNumber(candidate.tracePhase);
  if (tracePhase !== undefined && tracePhase >= 1) message.tracePhase = tracePhase;
  if (Array.isArray(candidate.annotations)) message.annotations = candidate.annotations as Message["annotations"];
  if (Array.isArray(candidate.sources)) message.sources = candidate.sources as Message["sources"];
  if (candidate.connectorApproval && typeof candidate.connectorApproval === "object") message.connectorApproval = candidate.connectorApproval as Message["connectorApproval"];
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
  return {
    id,
    user,
    assistant,
    ...(typeof candidate.parentVersionId === "string" || candidate.parentVersionId === null
      ? { parentVersionId: candidate.parentVersionId }
      : {}),
  };
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
  const projectId = typeof candidate.projectId === "string" && candidate.projectId.length > 0 ? candidate.projectId : undefined;
  if (Array.isArray(candidate.turns)) {
    const turns = candidate.turns
      .map((turn) => normalizeTurn(turn, options))
      .filter((turn): turn is ConversationTurn => turn !== null);
    return { id, title, ...(projectId ? { projectId } : {}), turns };
  }
  // The first client stored a flat alternating messages array. Convert pairs
  // without ever reading from or writing to browser storage.
  if (!Array.isArray(candidate.messages)) return null;
  const turns: ConversationTurn[] = [];
  for (let index = 0; index + 1 < candidate.messages.length; index += 2) {
    const user = normalizeStoredMessage(candidate.messages[index], { ...options, freezeRunningActivities: true });
    const assistant = normalizeStoredMessage(candidate.messages[index + 1], { ...options, freezeRunningActivities: true });
    if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") continue;
    const versionId = makeId();
    turns.push({
      id: makeId(),
      versions: [{ id: versionId, user, assistant, parentVersionId: turns.at(-1)?.versions[0]?.id ?? null }],
      activeVersion: 0,
    });
  }
  return { id, title, ...(projectId ? { projectId } : {}), turns };
}

/** Backward-compatible name for callers migrating old flat conversations. */
export const migrateConversation = normalizeConversation;

function validSummary(value: unknown): ChatConversationSummary | null {
  const candidate = asRecord(value);
  const id = nonEmptyString(candidate?.id);
  const title = typeof candidate?.title === "string" ? candidate.title : null;
  const updatedAt = typeof candidate?.updatedAt === "string" ? candidate.updatedAt : null;
  if (!id || title === null || updatedAt === null) return null;
  return {
    id,
    title,
    ...(typeof candidate?.projectId === "string" ? { projectId: candidate.projectId } : {}),
    updatedAt,
    hasMessages: candidate?.hasMessages === true,
    isStreaming: candidate?.isStreaming === true,
  };
}

export async function loadConversationIndex(
): Promise<LoadedConversationIndex> {
  const raw = await fetchChatConversations();
  const summaries = Array.isArray(raw)
    ? raw
        .map(validSummary)
        .filter(
          (summary): summary is ChatConversationSummary => summary !== null,
        )
    : [];
  return {
    summaries,
    streamingByConversation: Object.fromEntries(
      summaries
        .filter((summary) => summary.isStreaming)
        .map((summary) => [summary.id, "persisted"]),
    ),
  };
}

export async function loadConversation(
  conversationId: string,
): Promise<ChatConversation | null> {
  return normalizeConversation(
    await fetchChatConversation(conversationId),
    { freezeRunningActivities: false },
  );
}

/** Save server-owned conversation metadata. Transcript writes happen in jobs. */
export async function saveConversation(
  conversation: Conversation,
): Promise<void> {
  if (!conversation || typeof conversation.id !== "string" || !conversation.id) return;
  try {
    await updateChatConversation(conversation.id, { title: conversation.title });
  } catch {
    // Persistence is best effort at the UI boundary; the local reducer remains authoritative.
  }
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  if (!conversationId) return;
  await deleteChatConversation(conversationId);
}

export async function saveConversationSelection(
  conversationId: string,
  turnId: string,
  versionId: string,
): Promise<void> {
  if (!conversationId || !turnId || !versionId) return;
  try {
    await updateChatConversation(conversationId, { turnId, versionId });
  } catch {
    // See saveConversation: a transient metadata failure must not break chat UI.
  }
}

/** Load user preferences while always retaining the canonical system prompt. */
export async function loadSettings(): Promise<ChatSettings> {
  try {
    const value = await fetchChatUserPreferences();
    const parsed = parseChatUserPreferences(value) ?? DEFAULT_CHAT_USER_PREFERENCES;
    return {
      ...DEFAULT_CHAT_SETTINGS,
      userPresence: parsed.userPresence,
      visionModel: parsed.visionModel ?? null,
      automationModel: parsed.automationModel ?? DEFAULT_CHAT_SETTINGS.automationModel,
      focusedContextEnabled: parsed.focusedContextEnabled ?? false,
    };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

/** Save the remotely supported user preference; systemPrompt is canonical. */
export async function saveSettings(settings: ChatSettings): Promise<void> {
  const userPresence = typeof settings?.userPresence === "string"
    ? settings.userPresence.trim().slice(0, 12_000)
    : "";
  try {
    await saveChatUserPreferences({
      userPresence,
      visionModel: settings?.visionModel ?? null,
      automationModel: settings?.automationModel,
      focusedContextEnabled: settings?.focusedContextEnabled ?? false,
    });
  } catch {
    // Saving preferences is intentionally nonfatal, matching the existing UI policy.
  }
}
