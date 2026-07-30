import "server-only";

import { normalizeChatImageAttachments, type ChatJobStatus, type ChatRequest, type ChatStreamEvent } from "../../../lib/chat-protocol";
import { ChatImageError, type ChatImageAttachment } from "../../../lib/chat-image";
import type { ChatDocumentAttachment } from "../../../lib/chat-document";
import {
  applyChatStreamEvent,
  finalizeChatHistoryMessage,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatAssistantActivity,
  type ChatHistoryMessage,
  type ChatMessageStatus,
} from "../../../lib/chat-history";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { attachmentFromUploadRecord, listChatImageUploadRecords } from "./chat-image-store";
import type { ChatSearchResult } from "../../../lib/chat-search";
import type { TodoList } from "../../../lib/todo-protocol";

type MessageRow = {
  owner_id: string;
  conversation_id: string;
  turn_id: string;
  version_id: string;
  message_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  attachments: unknown;
  documents: unknown;
  activities: unknown;
  artifacts: unknown;
  thinking_enabled: boolean | null;
  thinking_duration_ms: number | null;
  status: ChatMessageStatus | null;
  error: string | null;
  job_id: string | null;
  last_sequence: number | string;
  trace_round: number | null;
  annotations: unknown;
  sources: unknown;
  todos: unknown;
};

function client() {
  return getServerClient();
}

export async function chatConversationExists(ownerId: string, conversationId: string): Promise<boolean> {
  const { data, error } = await client()
    .from("chat_conversations")
    .select("conversation_id")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function messageFromRow(row: MessageRow): ChatHistoryMessage {
  const attachments = normalizeChatImageAttachments(row.attachments);
  const activities = arrayValue<ChatAssistantActivity>(row.activities);
  const tracePhase = activities.reduce((latest, activity) => Math.max(
    latest,
    activity.kind === "phase_break" ? activity.nextPhase : activity.phase ?? 1,
  ), 1);
  return {
    id: row.message_id,
    role: row.role,
    content: row.content,
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    ...(attachments.length ? { attachments } : {}),
    ...(Array.isArray(row.documents) && row.documents.length ? { documents: row.documents as ChatDocumentAttachment[] } : {}),
    activities,
    artifacts: arrayValue(row.artifacts),
    ...(row.thinking_enabled === null ? {} : { thinkingEnabled: row.thinking_enabled }),
    ...(row.thinking_duration_ms === null ? {} : { thinkingDurationMs: row.thinking_duration_ms }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    lastSequence: Number(row.last_sequence ?? 0),
    ...(row.trace_round === null ? {} : { traceRound: row.trace_round }),
    tracePhase,
    ...(Array.isArray(row.annotations) && row.annotations.length ? { annotations: row.annotations } : {}),
    ...(Array.isArray(row.sources) && row.sources.length ? { sources: row.sources } : {}),
    ...(row.todos && typeof row.todos === "object" ? { todos: row.todos as TodoList } : {}),
  };
}

function messageRow(
  ownerId: string,
  conversationId: string,
  turnId: string,
  versionId: string,
  message: ChatHistoryMessage,
) {
  return {
    owner_id: ownerId,
    conversation_id: conversationId,
    turn_id: turnId,
    version_id: versionId,
    message_id: message.id,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning ?? null,
    attachments: message.attachments ?? [],
    documents: message.documents ?? [],
    activities: message.activities ?? [],
    artifacts: message.artifacts ?? [],
    thinking_enabled: message.thinkingEnabled ?? null,
    thinking_duration_ms: message.thinkingDurationMs ?? null,
    status: message.status ?? null,
    error: message.error ?? null,
    job_id: message.jobId ?? null,
    last_sequence: message.lastSequence ?? 0,
    trace_round: message.traceRound ?? null,
    annotations: message.annotations ?? [],
    sources: message.sources ?? [],
    todos: message.todos ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function insertIfAbsent(tableName: "chat_conversations" | "chat_turns" | "chat_message_versions" | "chat_messages", row: Record<string, unknown>) {
  const { error } = await client().from(tableName).insert(row);
  if (error && error.code !== "23505") throw error;
}

export async function createCompletedAutomationConversation(input: {
  ownerId: string;
  runId: string;
  title: string;
  prompt: string;
  output: string;
  reasoning?: string;
  thinkingEnabled?: boolean;
}): Promise<string> {
  const conversationId = input.runId;
  const turnId = `${input.runId}:turn`;
  const versionId = `${input.runId}:version`;
  const now = new Date().toISOString();
  await insertIfAbsent("chat_conversations", { owner_id: input.ownerId, conversation_id: conversationId, title: input.title.slice(0, 160), created_at: now, updated_at: now });
  await insertIfAbsent("chat_turns", { owner_id: input.ownerId, conversation_id: conversationId, turn_id: turnId, position: 0, active_version: 0, created_at: now, updated_at: now });
  await insertIfAbsent("chat_message_versions", { owner_id: input.ownerId, conversation_id: conversationId, turn_id: turnId, version_id: versionId, version_index: 0, created_at: now });
  await insertIfAbsent("chat_messages", messageRow(input.ownerId, conversationId, turnId, versionId, { id: `${input.runId}:user`, role: "user", content: input.prompt }));
  await insertIfAbsent("chat_messages", messageRow(input.ownerId, conversationId, turnId, versionId, { id: `${input.runId}:assistant`, role: "assistant", content: input.output, ...(input.reasoning ? { reasoning: input.reasoning } : {}), ...(input.thinkingEnabled !== undefined ? { thinkingEnabled: input.thinkingEnabled } : {}), status: "complete" }));
  return conversationId;
}

/**
 * Backfill lineage for old rows while the active linear path is still known.
 * This keeps pre-lineage conversations compatible when the first branch is
 * selected or a new response is generated from them.
 */
async function materializePersistedLineage(
  ownerId: string,
  conversationId: string,
  targetPosition: number,
): Promise<string | null> {
  const db = client();
  const [turnsResult, versionsResult] = await Promise.all([
    db.from("chat_turns")
      .select("turn_id,position,active_version")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .order("position"),
    db.from("chat_message_versions")
      .select("turn_id,version_id,version_index,parent_version_id")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
  ]);
  if (turnsResult.error) throw turnsResult.error;
  if (versionsResult.error) throw versionsResult.error;

  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: Number(row.version_index),
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }

  let parentVersionId: string | null = null;
  let targetParentVersionId: string | null = null;
  let targetSeen = false;
  for (const turn of turnsResult.data ?? []) {
    const position = Number(turn.position);
    const active = versionsByTurn.get(turn.turn_id)?.find(
      (version) => version.index === Number(turn.active_version),
    );
    if (position < targetPosition) {
      parentVersionId = active?.id ?? parentVersionId;
      continue;
    }
    if (!targetSeen) {
      targetParentVersionId = parentVersionId;
      targetSeen = true;
    }
    const { error } = await db
      .from("chat_message_versions")
      .update({ parent_version_id: parentVersionId })
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .eq("turn_id", turn.turn_id)
      .is("parent_version_id", null);
    if (error) throw error;
    parentVersionId = active?.id ?? parentVersionId;
  }
  return targetSeen ? targetParentVersionId : parentVersionId;
}

function requestImageIds(request: ChatRequest): string[] {
  const lastMessage = request.messages.at(-1);
  return [...new Set(lastMessage?.attachments?.map((attachment) => attachment.id) ?? [])];
}

export async function authoritativeAttachmentsForSubmission(
  ownerId: string,
  request: ChatRequest,
): Promise<ChatImageAttachment[]> {
  const imageIds = requestImageIds(request);
  const persistence = request.persistence;
  if (!imageIds.length || !persistence || !request.conversationId || !request.jobId) return [];

  const recordsById = new Map<string, ChatImageAttachment>();
  const currentRecords = await listChatImageUploadRecords({
    ownerId,
    conversationId: request.conversationId,
    userMessageId: persistence.userMessageId,
    jobId: request.jobId,
    imageIds,
    status: "complete",
  });
  for (const record of currentRecords) {
    const attachment = attachmentFromUploadRecord(record);
    if (attachment) recordsById.set(record.imageId, attachment);
  }

  const missingIds = imageIds.filter((imageId) => !recordsById.has(imageId));
  if (missingIds.length) {
    const activeMessages = await activeImageMessages(ownerId, request.conversationId);
    const requestUsers = request.messages.filter((message) => message.role === "user");
    const editedIndex = activeMessages.findIndex((message) => message.turnId === persistence.turnId);
    const previous = editedIndex >= 0 && requestUsers.length === editedIndex + 1
      ? activeMessages[editedIndex]
      : undefined;
    if (previous?.jobId) {
      const previousRecords = await listChatImageUploadRecords({
        ownerId,
        conversationId: request.conversationId,
        userMessageId: previous.userMessageId,
        jobId: previous.jobId,
        imageIds: missingIds,
        status: "complete",
      });
      for (const record of previousRecords) {
        const attachment = attachmentFromUploadRecord(record);
        if (attachment) recordsById.set(record.imageId, attachment);
      }
    }
  }

  return imageIds.map((imageId) => recordsById.get(imageId)).filter(
    (attachment): attachment is ChatImageAttachment => Boolean(attachment),
  );
}

type ActiveImageMessage = {
  turnId: string;
  versionId: string;
  position: number;
  userMessageId: string;
  jobId: string | null;
  attachments: ChatImageAttachment[];
};

function requestUserImageRefs(request: ChatRequest): Array<{ userIndex: number; imageId: string }> {
  let userIndex = -1;
  const refs: Array<{ userIndex: number; imageId: string }> = [];
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    userIndex += 1;
    for (const attachment of message.attachments ?? []) refs.push({ userIndex, imageId: attachment.id });
  }
  return refs;
}

async function activeImageMessages(ownerId: string, conversationId: string): Promise<ActiveImageMessage[]> {
  const db = client();
  const [turnsResult, versionsResult, messagesResult] = await Promise.all([
    db.from("chat_turns")
      .select("turn_id,position,active_version")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .order("position"),
    db.from("chat_message_versions")
      .select("turn_id,version_id,version_index,parent_version_id")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
    db.from("chat_messages")
      .select("message_id,turn_id,version_id,role,content,job_id,attachments")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
  ]);
  if (turnsResult.error || versionsResult.error || messagesResult.error) {
    throw new ChatImageError("storage", "Chat image metadata is unavailable.", 503);
  }
  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: Number(row.version_index),
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }
  const messages = (messagesResult.data ?? []) as Array<{
    message_id: string;
    turn_id: string;
    version_id: string;
    role: "user" | "assistant";
    content: string;
    job_id: string | null;
    attachments: unknown;
  }>;
  const hasLineage = [...versionsByTurn.values()].some((versions) =>
    versions.some((version) => typeof version.parentVersionId === "string"),
  );
  let parentVersionId: string | null = null;
  const activeMessages: ActiveImageMessage[] = [];
  for (const turn of turnsResult.data ?? []) {
    const candidates = versionsByTurn.get(turn.turn_id)?.filter((version) =>
      !hasLineage || (version.parentVersionId ?? null) === parentVersionId,
    ) ?? [];
    if (!candidates.length) break;
    const version = candidates.find(({ index }) => index === Number(turn.active_version)) ?? candidates.at(-1);
    if (!version) break;
    const pair = messages.filter((message) => message.turn_id === turn.turn_id && message.version_id === version.id);
    const user = pair.find((message) => message.role === "user");
    const assistant = pair.find((message) => message.role === "assistant");
    if (!user || !assistant) break;
    activeMessages.push({
      turnId: turn.turn_id,
      versionId: version.id,
      position: Number(turn.position),
      userMessageId: user.message_id,
      jobId: assistant.job_id,
      attachments: normalizeChatImageAttachments(user.attachments),
    });
    parentVersionId = version.id;
  }
  return activeMessages;
}

export async function getAuthoritativeChatImageIdsForRequest(ownerId: string, request: ChatRequest): Promise<string[]> {
  const conversationId = request.conversationId;
  const jobId = request.jobId;
  const persistence = request.persistence;
  const imageRefs = requestUserImageRefs(request);
  if (!conversationId || !jobId || !persistence || !imageRefs.length) return [];

  const db = client();
  const [jobResult, messageResult] = await Promise.all([
    db.from("chat_jobs")
      .select("request")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .eq("job_id", jobId)
      .maybeSingle(),
    db.from("chat_messages")
      .select("turn_id,version_id")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .eq("message_id", persistence.userMessageId)
      .eq("role", "user")
      .maybeSingle(),
  ]);
  if (jobResult.error || messageResult.error) throw new ChatImageError("storage", "Chat image metadata is unavailable.", 503);
  const persistedRequest = jobResult.data?.request as ChatRequest | undefined;
  const message = messageResult.data as { turn_id?: unknown; version_id?: unknown } | null;
  if (
    !persistedRequest
    || persistedRequest.conversationId !== conversationId
    || persistedRequest.jobId !== jobId
    || persistedRequest.persistence?.turnId !== persistence.turnId
    || persistedRequest.persistence?.versionId !== persistence.versionId
    || persistedRequest.persistence?.userMessageId !== persistence.userMessageId
    || !message
    || message.turn_id !== persistence.turnId
    || message.version_id !== persistence.versionId
  ) return [];

  const [versionResult, turnResult] = await Promise.all([
    db.from("chat_message_versions")
      .select("version_index")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .eq("turn_id", persistence.turnId)
      .eq("version_id", persistence.versionId)
      .maybeSingle(),
    db.from("chat_turns")
      .select("active_version")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .eq("turn_id", persistence.turnId)
      .maybeSingle(),
  ]);
  if (versionResult.error || turnResult.error) throw new ChatImageError("storage", "Chat image metadata is unavailable.", 503);
  if (
    !versionResult.data
    || !turnResult.data
    || Number(versionResult.data.version_index) !== persistence.versionIndex
    || Number(turnResult.data.active_version) !== persistence.versionIndex
  ) return [];

  const activeMessages = await activeImageMessages(ownerId, conversationId);
  const currentIndex = activeMessages.findIndex((active) =>
    active.turnId === persistence.turnId
    && active.versionId === persistence.versionId
    && active.userMessageId === persistence.userMessageId,
  );
  if (currentIndex < 0 || activeMessages[currentIndex].jobId !== jobId) return [];
  const activeHistory = activeMessages.slice(0, currentIndex + 1);
  const requestUsers = request.messages.filter((message) => message.role === "user");
  if (requestUsers.length !== activeHistory.length) return [];

  const refsByUserIndex = new Map<number, string[]>();
  for (const ref of imageRefs) {
    const ids = refsByUserIndex.get(ref.userIndex) ?? [];
    if (!ids.includes(ref.imageId)) ids.push(ref.imageId);
    refsByUserIndex.set(ref.userIndex, ids);
  }
  const recordsByImageId = new Map<string, ReturnType<typeof attachmentFromUploadRecord>>();
  for (const [userIndex, imageIds] of refsByUserIndex) {
    const active = activeHistory[userIndex];
    if (!active?.jobId) continue;
    for (const attachment of active.attachments) {
      if (imageIds.includes(attachment.id)) recordsByImageId.set(attachment.id, attachment);
    }
    const records = await listChatImageUploadRecords({
      ownerId,
      conversationId,
      userMessageId: active.userMessageId,
      jobId: active.jobId,
      imageIds,
      status: "complete",
    });
    const recordsById = new Map(records.map((record) => [record.imageId, record]));
    for (const imageId of imageIds) {
      const record = recordsById.get(imageId);
      if (record) recordsByImageId.set(imageId, attachmentFromUploadRecord(record));
    }
  }
  return imageRefs
    .filter(({ imageId }) => Boolean(recordsByImageId.get(imageId)))
    .map(({ imageId }) => imageId)
    .filter((imageId, index, ids) => ids.indexOf(imageId) === index);
}

function messageStatusForJob(status: ChatJobStatus): ChatMessageStatus | null {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  return null;
}

export async function ensureChatSubmission(ownerId: string, request: ChatRequest): Promise<void> {
  const persistence = request.persistence;
  const conversationId = request.conversationId;
  const jobId = request.jobId;
  const lastMessage = request.messages.at(-1);
  if (!persistence || !conversationId || !jobId || !lastMessage || lastMessage.role !== "user") {
    throw new Error("Chat persistence metadata is incomplete.");
  }
  const requestedImageIds = requestImageIds(request);
  const authoritativeAttachments = await authoritativeAttachmentsForSubmission(ownerId, request);
  if (authoritativeAttachments.length !== requestedImageIds.length) {
    throw new ChatImageError("image_not_found", "Chat image metadata is invalid.", 400);
  }
  /* Client attachment descriptors are only IDs at this boundary; all metadata comes from uploads. */

  const now = new Date().toISOString();
  const parentVersionId = await materializePersistedLineage(
    ownerId,
    conversationId,
    persistence.turnIndex,
  );
  await insertIfAbsent("chat_conversations", {
    owner_id: ownerId,
    conversation_id: conversationId,
    title: "New conversation",
    updated_at: now,
  });
  await insertIfAbsent("chat_turns", {
    owner_id: ownerId,
    conversation_id: conversationId,
    turn_id: persistence.turnId,
    position: persistence.turnIndex,
    active_version: persistence.versionIndex,
    updated_at: now,
  });
  await insertIfAbsent("chat_message_versions", {
    owner_id: ownerId,
    conversation_id: conversationId,
    turn_id: persistence.turnId,
    version_id: persistence.versionId,
    version_index: persistence.versionIndex,
    parent_version_id: parentVersionId,
  });

  const userMessage: ChatHistoryMessage = {
    id: persistence.userMessageId,
    role: "user",
    content: lastMessage.content,
    ...(authoritativeAttachments.length ? { attachments: authoritativeAttachments } : {}),
    ...(lastMessage.documents?.length ? { documents: lastMessage.documents } : {}),
  };
  const assistantMessage: ChatHistoryMessage = {
    id: persistence.assistantMessageId,
    role: "assistant",
    content: "",
    reasoning: "",
    activities: [],
    artifacts: [],
    thinkingEnabled: request.thinking,
    status: "streaming",
    jobId,
    lastSequence: 0,
  };
  await insertIfAbsent("chat_messages", messageRow(ownerId, conversationId, persistence.turnId, persistence.versionId, userMessage));
  await insertIfAbsent("chat_messages", messageRow(ownerId, conversationId, persistence.turnId, persistence.versionId, assistantMessage));

  const { error: turnError } = await client()
    .from("chat_turns")
    .update({ active_version: persistence.versionIndex, updated_at: now })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("turn_id", persistence.turnId);
  if (turnError) throw turnError;
  const { error: conversationError } = await client()
    .from("chat_conversations")
    .update({ updated_at: now })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (conversationError) throw conversationError;
}

export async function finalizeChatJobMessage(
  ownerId: string,
  conversationId: string,
  jobId: string,
  status: ChatMessageStatus,
  values: { error?: string | null; finalOutput?: string | null } = {},
): Promise<void> {
  const { data, error } = await client()
    .from("chat_messages")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("job_id", jobId)
    .eq("role", "assistant")
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  const row = data as MessageRow;
  const next = finalizeChatHistoryMessage(messageFromRow(row), status, values);
  const { error: updateError } = await client()
    .from("chat_messages")
    .update(messageRow(ownerId, conversationId, row.turn_id, row.version_id, next))
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("message_id", next.id);
  if (updateError) throw updateError;
  await touchConversation(ownerId, conversationId);
}

async function touchConversation(ownerId: string, conversationId: string): Promise<void> {
  const { error } = await client()
    .from("chat_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (error) throw error;
}

export type ChatConversationIndexRow = {
  conversation_id: string;
  title: string;
  updated_at: string;
  has_messages: boolean;
  is_streaming: boolean;
};

export function mapChatConversationSummaryRows(rows: ChatConversationIndexRow[]): ChatConversationSummary[] {
  return rows.map((row) => ({
    id: row.conversation_id,
    title: row.title,
    updatedAt: row.updated_at,
    hasMessages: row.has_messages,
    isStreaming: row.is_streaming,
  }));
}

export async function listChatConversations(ownerId: string): Promise<ChatConversationSummary[]> {
  const { data, error } = await client().rpc("list_chat_conversations_fast", {
    p_owner_id: ownerId,
  });
  if (error) throw error;
  return mapChatConversationSummaryRows((data ?? []) as ChatConversationIndexRow[]);
}

export async function searchChatConversations(ownerId: string, query: string): Promise<ChatSearchResult[]> {
  const { data, error } = await client().rpc("search_chat_conversations", {
    p_owner_id: ownerId,
    p_query: query,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{
    conversation_id: string;
    title: string;
    updated_at: string;
    preview: string | null;
  }>).map((row) => ({
    id: row.conversation_id,
    title: row.title,
    updatedAt: row.updated_at,
    preview: row.preview ?? "",
  }));
}

export async function getChatConversation(ownerId: string, conversationId: string): Promise<ChatConversation | null> {
  const db = client();
  const [conversationResult, turnsResult, versionsResult, messagesResult] = await Promise.all([
    db.from("chat_conversations").select("conversation_id,title").eq("owner_id", ownerId).eq("conversation_id", conversationId).maybeSingle(),
    db.from("chat_turns").select("turn_id,position,active_version").eq("owner_id", ownerId).eq("conversation_id", conversationId).order("position"),
    db.from("chat_message_versions").select("turn_id,version_id,version_index,parent_version_id").eq("owner_id", ownerId).eq("conversation_id", conversationId).order("version_index"),
    db.from("chat_messages").select("*").eq("owner_id", ownerId).eq("conversation_id", conversationId),
  ]);
  if (conversationResult.error) throw conversationResult.error;
  if (!conversationResult.data) return null;
  if (turnsResult.error) throw turnsResult.error;
  if (versionsResult.error) throw versionsResult.error;
  if (messagesResult.error) throw messagesResult.error;

  let messages = (messagesResult.data ?? []) as MessageRow[];
  const jobIds = [...new Set(messages.map((message) => message.job_id).filter((jobId): jobId is string => Boolean(jobId)))];
  if (jobIds.length) {
    const [eventsResult, jobsResult] = await Promise.all([
      db.from("chat_job_events").select("job_id,event_index,event").eq("owner_id", ownerId).eq("conversation_id", conversationId).in("job_id", jobIds).order("event_index"),
      db.from("chat_jobs").select("job_id,status,error,final_output").eq("owner_id", ownerId).eq("conversation_id", conversationId).in("job_id", jobIds),
    ]);
    if (eventsResult.error) throw eventsResult.error;
    if (jobsResult.error) throw jobsResult.error;
    const eventsByJob = new Map<string, Array<{ sequence: number; event: ChatStreamEvent }>>();
    for (const row of eventsResult.data ?? []) {
      const eventList = eventsByJob.get(row.job_id) ?? [];
      eventList.push({ sequence: Number(row.event_index), event: row.event as ChatStreamEvent });
      eventsByJob.set(row.job_id, eventList);
    }
    const jobsById = new Map((jobsResult.data ?? []).map((job) => [job.job_id, job]));
    messages = messages.map((row) => {
      if (!row.job_id) return row;
      let projected = messageFromRow(row);
      for (const item of eventsByJob.get(row.job_id) ?? []) {
        if (item.sequence > (projected.lastSequence ?? 0)) projected = applyChatStreamEvent(projected, item.event, item.sequence);
      }
      const job = jobsById.get(row.job_id);
      const messageStatus = job ? messageStatusForJob(job.status as ChatJobStatus) : null;
      if (job && messageStatus) {
        projected = finalizeChatHistoryMessage(projected, messageStatus, {
          error: job.error,
          finalOutput: job.final_output,
        });
      }
      return {
        ...row,
        ...messageRow(ownerId, conversationId, row.turn_id, row.version_id, projected),
      } as MessageRow;
    });
  }
  const messagesByVersion = new Map<string, { user?: ChatHistoryMessage; assistant?: ChatHistoryMessage }>();
  for (const row of messages) {
    const pair = messagesByVersion.get(row.version_id) ?? {};
    pair[row.role] = messageFromRow(row);
    messagesByVersion.set(row.version_id, pair);
  }
  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: row.version_index,
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }
  return {
    id: conversationResult.data.conversation_id,
    title: conversationResult.data.title,
    turns: (turnsResult.data ?? []).map((turn) => ({
      id: turn.turn_id,
      activeVersion: turn.active_version,
      versions: (versionsByTurn.get(turn.turn_id) ?? []).sort((left, right) => left.index - right.index).flatMap((version) => {
        const pair = messagesByVersion.get(version.id);
        return pair?.user && pair.assistant ? [{
          id: version.id,
          user: pair.user,
          assistant: pair.assistant,
          ...(version.parentVersionId
            ? { parentVersionId: version.parentVersionId }
            : {}),
        }] : [];
      }),
    })),
  };
}

export async function updateChatConversationTitle(ownerId: string, conversationId: string, title: string): Promise<void> {
  const { error } = await client()
    .from("chat_conversations")
    .update({ title: title.trim().slice(0, 160), updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (error) throw error;
}

export async function deleteChatConversationRecord(ownerId: string, conversationId: string): Promise<void> {
  const { error } = await client()
    .from("chat_conversations")
    .delete()
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (error) throw error;
}

export async function updateChatActiveVersion(ownerId: string, conversationId: string, turnId: string, versionId: string): Promise<void> {
  const { data: version, error: versionError } = await client()
    .from("chat_message_versions")
    .select("version_index")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("turn_id", turnId)
    .eq("version_id", versionId)
    .maybeSingle();
  if (versionError) throw versionError;
  if (!version) throw new Error("Conversation version not found.");
  const { data: turn, error: turnReadError } = await client()
    .from("chat_turns")
    .select("position")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("turn_id", turnId)
    .maybeSingle();
  if (turnReadError) throw turnReadError;
  if (!turn) throw new Error("Conversation turn not found.");
  await materializePersistedLineage(ownerId, conversationId, Number(turn.position));
  const { error } = await client()
    .from("chat_turns")
    .update({ active_version: version.version_index, updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("turn_id", turnId);
  if (error) throw error;
}
