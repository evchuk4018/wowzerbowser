import "server-only";

import { normalizeChatImageAttachments, type ChatJobStatus, type ChatRequest, type ChatStreamEvent, type ChatStreamMetrics } from "../../../lib/chat-protocol";
import { ChatImageError, type ChatImageAttachment } from "../../../lib/chat-image";
import {
  applyChatStreamEvent,
  finalizeChatHistoryMessage,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatHistoryMessage,
  type ChatMessageStatus,
} from "../../../lib/chat-history";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { attachmentFromUploadRecord, listChatImageUploadRecords } from "./chat-image-store";
import { messageFromRow, messageRow, type MessageRow } from "./chat-history-mappers";
import type { ChatSearchResult } from "../../../lib/chat-search";

export async function chatConversationExists(ownerId: string, conversationId: string): Promise<boolean> {
  const [row] = await query("select conversation_id from chat_conversations where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
  return Boolean(row);
}

export async function chatConversationHasMessages(ownerId: string, conversationId: string): Promise<boolean> {
  const [row] = await query("select message_id from chat_messages where owner_id=$1 and conversation_id=$2 limit 1", [databaseOwnerId(ownerId), conversationId]);
  return Boolean(row);
}

async function insertIfAbsent(tableName: "chat_conversations" | "chat_turns" | "chat_message_versions" | "chat_messages", row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const jsonColumns = new Set(["attachments", "documents", "activities", "artifacts", "annotations", "sources", "todos", "stream_metrics"]);
  const values = entries.map(([key, value]) => jsonColumns.has(key) ? jsonb(value) : value);
  const placeholders = entries.map(([key], index) => jsonColumns.has(key) ? `$${index + 1}::jsonb` : `$${index + 1}`);
  try {
    await query(`insert into ${tableName} (${entries.map(([key]) => key).join(",")}) values (${placeholders.join(",")}) on conflict do nothing`, values);
  } catch (error) {
    throw error;
  }
}

export async function createCompletedAutomationConversation(input: {
  ownerId: string;
  runId: string;
  title: string;
  prompt: string;
  output: string;
}): Promise<string> {
  const conversationId = input.runId;
  const turnId = `${input.runId}:turn`;
  const versionId = `${input.runId}:version`;
  const now = new Date().toISOString();
  const owner = databaseOwnerId(input.ownerId);
  await insertIfAbsent("chat_conversations", { owner_id: owner, conversation_id: conversationId, title: input.title.slice(0, 160), created_at: now, updated_at: now });
  await insertIfAbsent("chat_turns", { owner_id: owner, conversation_id: conversationId, turn_id: turnId, position: 0, active_version: 0, created_at: now, updated_at: now });
  await insertIfAbsent("chat_message_versions", { owner_id: owner, conversation_id: conversationId, turn_id: turnId, version_id: versionId, version_index: 0, created_at: now });
  await insertIfAbsent("chat_messages", messageRow(owner, conversationId, turnId, versionId, { id: `${input.runId}:user`, role: "user", content: input.prompt }));
  await insertIfAbsent("chat_messages", messageRow(owner, conversationId, turnId, versionId, { id: `${input.runId}:assistant`, role: "assistant", content: input.output, status: "complete" }));
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
  const owner = databaseOwnerId(ownerId);
  const [turnsResult, versionsResult] = await Promise.all([
    query<{ turn_id: string; position: number; active_version: number }>("select turn_id,position,active_version from chat_turns where owner_id=$1 and conversation_id=$2 order by position", [owner, conversationId]),
    query<{ turn_id: string; version_id: string; version_index: number; parent_version_id: string | null }>("select turn_id,version_id,version_index,parent_version_id from chat_message_versions where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
  ]);

  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult) {
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
  for (const turn of turnsResult) {
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
    await query("update chat_message_versions set parent_version_id=$1 where owner_id=$2 and conversation_id=$3 and turn_id=$4 and parent_version_id is null", [parentVersionId, owner, conversationId, turn.turn_id]);
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
    ...(request.projectId ? { projectId: request.projectId } : {}),
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
        ...(request.projectId ? { projectId: request.projectId } : {}),
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
  const owner = databaseOwnerId(ownerId);
  const [turnsResult, versionsResult, messagesResult] = await Promise.all([
    query<{ turn_id: string; position: number; active_version: number }>("select turn_id,position,active_version from chat_turns where owner_id=$1 and conversation_id=$2 order by position", [owner, conversationId]),
    query<{ turn_id: string; version_id: string; version_index: number; parent_version_id: string | null }>("select turn_id,version_id,version_index,parent_version_id from chat_message_versions where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
    query<{ message_id: string; turn_id: string; version_id: string; role: "user" | "assistant"; content: string; job_id: string | null; attachments: unknown }>("select message_id,turn_id,version_id,role,content,job_id,attachments from chat_messages where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
  ]);
  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: Number(row.version_index),
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }
  const messages = messagesResult as Array<{
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
  for (const turn of turnsResult) {
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

  const owner = databaseOwnerId(ownerId);
  const [jobResult, messageResult] = await Promise.all([
    query<{ request: unknown }>("select request from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, conversationId, jobId]),
    query<{ turn_id: string; version_id: string }>("select turn_id,version_id from chat_messages where owner_id=$1 and conversation_id=$2 and message_id=$3 and role='user'", [owner, conversationId, persistence.userMessageId]),
  ]);
  const persistedRequest = jobResult[0]?.request as ChatRequest | undefined;
  const message = messageResult[0] as { turn_id?: unknown; version_id?: unknown } | undefined;
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
    query<{ version_index: number }>("select version_index from chat_message_versions where owner_id=$1 and conversation_id=$2 and turn_id=$3 and version_id=$4", [owner, conversationId, persistence.turnId, persistence.versionId]),
    query<{ active_version: number }>("select active_version from chat_turns where owner_id=$1 and conversation_id=$2 and turn_id=$3", [owner, conversationId, persistence.turnId]),
  ]);
  if (
    !versionResult[0]
    || !turnResult[0]
    || Number(versionResult[0].version_index) !== persistence.versionIndex
    || Number(turnResult[0].active_version) !== persistence.versionIndex
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
      ...(request.projectId ? { projectId: request.projectId } : {}),
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

  const owner = databaseOwnerId(ownerId);
  const now = new Date().toISOString();
  const parentVersionId = await materializePersistedLineage(
    ownerId,
    conversationId,
    persistence.turnIndex,
  );
  await insertIfAbsent("chat_conversations", {
    owner_id: owner,
    conversation_id: conversationId,
    project_id: request.projectId ?? null,
    title: "New conversation",
    updated_at: now,
  });
  await insertIfAbsent("chat_turns", {
    owner_id: owner,
    conversation_id: conversationId,
    turn_id: persistence.turnId,
    position: persistence.turnIndex,
    active_version: persistence.versionIndex,
    updated_at: now,
  });
  await insertIfAbsent("chat_message_versions", {
    owner_id: owner,
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
  await insertIfAbsent("chat_messages", messageRow(owner, conversationId, persistence.turnId, persistence.versionId, userMessage));
  await insertIfAbsent("chat_messages", messageRow(owner, conversationId, persistence.turnId, persistence.versionId, assistantMessage));

  await query("update chat_turns set active_version=$1,updated_at=$2 where owner_id=$3 and conversation_id=$4 and turn_id=$5", [persistence.versionIndex, now, owner, conversationId, persistence.turnId]);
  await query("update chat_conversations set updated_at=$1 where owner_id=$2 and conversation_id=$3", [now, owner, conversationId]);
}

export async function finalizeChatJobMessage(
  ownerId: string,
  conversationId: string,
  jobId: string,
  status: ChatMessageStatus,
  values: { error?: string | null; finalOutput?: string | null } = {},
): Promise<void> {
  const owner = databaseOwnerId(ownerId);
  const [data] = await query<MessageRow>("select * from chat_messages where owner_id=$1 and conversation_id=$2 and job_id=$3 and role='assistant'", [owner, conversationId, jobId]);
  if (!data) return;
  const row = data;
  const next = finalizeChatHistoryMessage(messageFromRow(row), status, values);
  const replacement = messageRow(owner, conversationId, row.turn_id, row.version_id, next);
  await query(`update chat_messages set content=$1,reasoning=$2,attachments=$3::jsonb,documents=$4::jsonb,activities=$5::jsonb,artifacts=$6::jsonb,thinking_enabled=$7,thinking_duration_ms=$8,status=$9,error=$10,job_id=$11,last_sequence=$12,trace_round=$13,annotations=$14::jsonb,sources=$15::jsonb,todos=$16::jsonb,updated_at=$17 where owner_id=$18 and conversation_id=$19 and message_id=$20`, [replacement.content, replacement.reasoning, jsonb(replacement.attachments), jsonb(replacement.documents), jsonb(replacement.activities), jsonb(replacement.artifacts), replacement.thinking_enabled, replacement.thinking_duration_ms, replacement.status, replacement.error, replacement.job_id, replacement.last_sequence, replacement.trace_round, jsonb(replacement.annotations), jsonb(replacement.sources), jsonb(replacement.todos), replacement.updated_at, owner, conversationId, next.id]);
  await touchConversation(ownerId, conversationId);
}

async function touchConversation(ownerId: string, conversationId: string): Promise<void> {
  await query("update chat_conversations set updated_at=$1 where owner_id=$2 and conversation_id=$3", [new Date().toISOString(), databaseOwnerId(ownerId), conversationId]);
}

export type ChatConversationIndexRow = {
  conversation_id: string;
  title: string;
  updated_at: string;
  has_messages: boolean;
  is_streaming: boolean;
  project_id?: string | null;
};

export function mapChatConversationSummaryRows(rows: ChatConversationIndexRow[]): ChatConversationSummary[] {
  const maxResults = Math.min(runtimeConfigSnapshot().chatHistorySearchMaxResults, 250);
  return rows.slice(0, maxResults).map((row) => ({
    id: row.conversation_id,
    title: row.title,
    updatedAt: row.updated_at,
    hasMessages: row.has_messages,
    isStreaming: row.is_streaming,
    ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
  }));
}

export async function listChatConversations(ownerId: string): Promise<ChatConversationSummary[]> {
  const rows = await query<ChatConversationIndexRow>("select conversation_id,title,updated_at,has_messages,is_streaming,project_id from list_chat_conversations_fast($1)", [databaseOwnerId(ownerId)]);
  return mapChatConversationSummaryRows(rows.map((row) => ({ ...row, updated_at: isoTimestamp(row.updated_at) })));
}

export async function searchChatConversations(ownerId: string, searchTerm: string): Promise<ChatSearchResult[]> {
  const rows = await query<{
    conversation_id: string;
    title: string;
    updated_at: unknown;
    preview: string | null;
  }>("select conversation_id,title,updated_at,preview from search_chat_conversations($1,$2)", [databaseOwnerId(ownerId), searchTerm]);
  const maxResults = Math.min(runtimeConfigSnapshot().chatHistorySearchMaxResults, 250);
  return rows.slice(0, maxResults).map((row) => ({
    id: row.conversation_id,
    title: row.title,
    updatedAt: isoTimestamp(row.updated_at),
    preview: row.preview ?? "",
  }));
}

export async function getChatConversation(ownerId: string, conversationId: string): Promise<ChatConversation | null> {
  const owner = databaseOwnerId(ownerId);
  const [conversationResult, turnsResult, versionsResult, messagesResult] = await Promise.all([
    query<{ conversation_id: string; title: string; project_id: string | null }>("select conversation_id,title,project_id from chat_conversations where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
    query<{ turn_id: string; position: number; active_version: number }>("select turn_id,position,active_version from chat_turns where owner_id=$1 and conversation_id=$2 order by position", [owner, conversationId]),
    query<{ turn_id: string; version_id: string; version_index: number; parent_version_id: string | null }>("select turn_id,version_id,version_index,parent_version_id from chat_message_versions where owner_id=$1 and conversation_id=$2 order by version_index", [owner, conversationId]),
    query<MessageRow>("select * from chat_messages where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
  ]);
  const conversation = conversationResult[0];
  if (!conversation) return null;

  let messages = messagesResult;
  const jobIds = [...new Set(messages.map((message) => message.job_id).filter((jobId): jobId is string => Boolean(jobId)))];
  if (jobIds.length) {
    const [eventsResult, jobsResult] = await Promise.all([
      query<{ job_id: string; event_index: number | string; event: ChatStreamEvent }>("select job_id,event_index,event from chat_job_events where owner_id=$1 and conversation_id=$2 and job_id=any($3::text[]) order by event_index", [owner, conversationId, jobIds]),
      query<{ job_id: string; status: ChatJobStatus; error: string | null; final_output: string | null; provider_metrics: unknown }>("select job_id,status,error,final_output,provider_metrics from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=any($3::text[])", [owner, conversationId, jobIds]),
    ]);
    const eventsByJob = new Map<string, Array<{ sequence: number; event: ChatStreamEvent }>>();
    for (const row of eventsResult) {
      const eventList = eventsByJob.get(row.job_id) ?? [];
      eventList.push({ sequence: Number(row.event_index), event: row.event as ChatStreamEvent });
      eventsByJob.set(row.job_id, eventList);
    }
    const jobsById = new Map(jobsResult.map((job) => [job.job_id, job]));
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
          streamMetrics: job.provider_metrics && typeof job.provider_metrics === "object" && !Array.isArray(job.provider_metrics)
            ? job.provider_metrics as ChatStreamMetrics
            : null,
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
  for (const row of versionsResult) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: row.version_index,
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }
  return {
    id: conversation.conversation_id,
    title: conversation.title,
    ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
    turns: turnsResult.map((turn) => ({
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
  await query("update chat_conversations set title=$1,updated_at=$2 where owner_id=$3 and conversation_id=$4", [title.trim().slice(0, 160), new Date().toISOString(), databaseOwnerId(ownerId), conversationId]);
}

export async function deleteChatConversationRecord(ownerId: string, conversationId: string): Promise<void> {
  await query("delete from chat_conversations where owner_id=$1 and conversation_id=$2", [databaseOwnerId(ownerId), conversationId]);
}

export async function updateChatActiveVersion(ownerId: string, conversationId: string, turnId: string, versionId: string): Promise<void> {
  const owner = databaseOwnerId(ownerId);
  const [version] = await query<{ version_index: number }>("select version_index from chat_message_versions where owner_id=$1 and conversation_id=$2 and turn_id=$3 and version_id=$4", [owner, conversationId, turnId, versionId]);
  if (!version) throw new Error("Conversation version not found.");
  const [turn] = await query<{ position: number }>("select position from chat_turns where owner_id=$1 and conversation_id=$2 and turn_id=$3", [owner, conversationId, turnId]);
  if (!turn) throw new Error("Conversation turn not found.");
  await materializePersistedLineage(ownerId, conversationId, Number(turn.position));
  await query("update chat_turns set active_version=$1,updated_at=$2 where owner_id=$3 and conversation_id=$4 and turn_id=$5", [version.version_index, new Date().toISOString(), owner, conversationId, turnId]);
}
