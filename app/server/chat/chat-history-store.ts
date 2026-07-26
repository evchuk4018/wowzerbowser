import "server-only";

import { normalizeChatImageAttachments, type ChatJobStatus, type ChatRequest, type ChatStreamEvent } from "../../../lib/chat-protocol";
import { ChatImageError, type ChatImageAttachment } from "../../../lib/chat-image";
import {
  applyChatStreamEvent,
  finalizeChatHistoryMessage,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatHistoryMessage,
  type ChatMessageStatus,
} from "../../../lib/chat-history";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { attachmentFromUploadRecord, listChatImageUploadRecords } from "./chat-image-store";

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
  activities: unknown;
  artifacts: unknown;
  thinking_enabled: boolean | null;
  thinking_duration_ms: number | null;
  status: ChatMessageStatus | null;
  error: string | null;
  job_id: string | null;
  last_sequence: number | string;
  trace_round: number | null;
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
  return {
    id: row.message_id,
    role: row.role,
    content: row.content,
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    ...(attachments.length ? { attachments } : {}),
    activities: arrayValue(row.activities),
    artifacts: arrayValue(row.artifacts),
    ...(row.thinking_enabled === null ? {} : { thinkingEnabled: row.thinking_enabled }),
    ...(row.thinking_duration_ms === null ? {} : { thinkingDurationMs: row.thinking_duration_ms }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    lastSequence: Number(row.last_sequence ?? 0),
    ...(row.trace_round === null ? {} : { traceRound: row.trace_round }),
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
    activities: message.activities ?? [],
    artifacts: message.artifacts ?? [],
    thinking_enabled: message.thinkingEnabled ?? null,
    thinking_duration_ms: message.thinkingDurationMs ?? null,
    status: message.status ?? null,
    error: message.error ?? null,
    job_id: message.jobId ?? null,
    last_sequence: message.lastSequence ?? 0,
    trace_round: message.traceRound ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function insertIfAbsent(tableName: "chat_conversations" | "chat_turns" | "chat_message_versions" | "chat_messages", row: Record<string, unknown>) {
  const { error } = await client().from(tableName).insert(row);
  if (error && error.code !== "23505") throw error;
}

function requestImageIds(request: ChatRequest): string[] {
  const lastMessage = request.messages.at(-1);
  return [...new Set(lastMessage?.attachments?.map((attachment) => attachment.id) ?? [])];
}

type ActiveImageMessage = {
  turnId: string;
  versionId: string;
  position: number;
  userMessageId: string;
  jobId: string | null;
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
      .select("turn_id,version_id,version_index")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
    db.from("chat_messages")
      .select("message_id,turn_id,version_id,role,content,job_id")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
  ]);
  if (turnsResult.error || versionsResult.error || messagesResult.error) {
    throw new ChatImageError("storage", "Chat image metadata is unavailable.", 503);
  }
  const versionsByTurn = new Map<string, Array<{ id: string; index: number }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({ id: row.version_id, index: Number(row.version_index) });
    versionsByTurn.set(row.turn_id, versions);
  }
  const messages = (messagesResult.data ?? []) as Array<{
    message_id: string;
    turn_id: string;
    version_id: string;
    role: "user" | "assistant";
    content: string;
    job_id: string | null;
  }>;
  return (turnsResult.data ?? []).flatMap((turn) => {
    const version = versionsByTurn.get(turn.turn_id)?.find(({ index }) => index === Number(turn.active_version));
    if (!version) return [];
    const pair = messages.filter((message) => message.turn_id === turn.turn_id && message.version_id === version.id);
    const user = pair.find((message) => message.role === "user");
    const assistant = pair.find((message) => message.role === "assistant");
    if (!user || !assistant) return [];
    return [{
      turnId: turn.turn_id,
      versionId: version.id,
      position: Number(turn.position),
      userMessageId: user.message_id,
      jobId: assistant.job_id,
    }];
  });
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
  let authoritativeAttachments: ChatImageAttachment[] = [];
  if (requestedImageIds.length) {
    const records = await listChatImageUploadRecords({
      ownerId,
      conversationId,
      userMessageId: persistence.userMessageId,
      jobId,
      imageIds: requestedImageIds,
      status: "complete",
    });
    const recordsById = new Map(records.map((record) => [record.imageId, record]));
    authoritativeAttachments = requestedImageIds.map((imageId) => {
      const record = recordsById.get(imageId);
      const attachment = record && attachmentFromUploadRecord(record);
      if (!attachment) throw new ChatImageError("image_not_found", "Chat image metadata is invalid.", 400);
      return attachment;
    });
  }
  /* Client attachment descriptors are only IDs at this boundary; all metadata comes from uploads. */

  const now = new Date().toISOString();
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
  });

  const userMessage: ChatHistoryMessage = {
    id: persistence.userMessageId,
    role: "user",
    content: lastMessage.content,
    ...(authoritativeAttachments.length ? { attachments: authoritativeAttachments } : {}),
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

export async function listChatConversations(ownerId: string): Promise<ChatConversationSummary[]> {
  const db = client();
  const [conversationResult, messageResult] = await Promise.all([
    db.from("chat_conversations").select("conversation_id,title,updated_at").eq("owner_id", ownerId).order("updated_at", { ascending: false }),
    db.from("chat_messages").select("conversation_id,role,status").eq("owner_id", ownerId),
  ]);
  if (conversationResult.error) throw conversationResult.error;
  if (messageResult.error) throw messageResult.error;
  const messagesByConversation = new Map<string, Array<{ role: string; status: string | null }>>();
  for (const row of messageResult.data ?? []) {
    const list = messagesByConversation.get(row.conversation_id) ?? [];
    list.push({ role: row.role, status: row.status });
    messagesByConversation.set(row.conversation_id, list);
  }
  return (conversationResult.data ?? []).map((row) => {
    const messages = messagesByConversation.get(row.conversation_id) ?? [];
    return {
      id: row.conversation_id,
      title: row.title,
      updatedAt: row.updated_at,
      hasMessages: messages.length > 0,
      isStreaming: messages.some((message) => message.role === "assistant" && message.status === "streaming"),
    };
  });
}

export async function getChatConversation(ownerId: string, conversationId: string): Promise<ChatConversation | null> {
  const db = client();
  const [conversationResult, turnsResult, versionsResult, messagesResult] = await Promise.all([
    db.from("chat_conversations").select("conversation_id,title").eq("owner_id", ownerId).eq("conversation_id", conversationId).maybeSingle(),
    db.from("chat_turns").select("turn_id,position,active_version").eq("owner_id", ownerId).eq("conversation_id", conversationId).order("position"),
    db.from("chat_message_versions").select("turn_id,version_id,version_index").eq("owner_id", ownerId).eq("conversation_id", conversationId).order("version_index"),
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
  const versionsByTurn = new Map<string, Array<{ id: string; index: number }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({ id: row.version_id, index: row.version_index });
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
        return pair?.user && pair.assistant ? [{ id: version.id, user: pair.user, assistant: pair.assistant }] : [];
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
  const { error } = await client()
    .from("chat_turns")
    .update({ active_version: version.version_index, updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("turn_id", turnId);
  if (error) throw error;
}
