import "server-only";

import type { ChatJobStatus, ChatRequest, ChatStreamEvent } from "../../../lib/chat-protocol";
import {
  applyChatStreamEvent,
  finalizeChatHistoryMessage,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatHistoryMessage,
  type ChatMessageStatus,
} from "../../../lib/chat-history";
import { getServerClient } from "../../auth/supabase-server-adapter";

type MessageRow = {
  owner_id: string;
  conversation_id: string;
  turn_id: string;
  version_id: string;
  message_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
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

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function messageFromRow(row: MessageRow): ChatHistoryMessage {
  return {
    id: row.message_id,
    role: row.role,
    content: row.content,
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
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

export async function applyChatJobEvent(
  ownerId: string,
  conversationId: string,
  jobId: string,
  event: ChatStreamEvent,
  sequence: number,
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
  const next = applyChatStreamEvent(messageFromRow(data as MessageRow), event, sequence);
  const { error: updateError } = await client()
    .from("chat_messages")
    .update(messageRow(ownerId, conversationId, data.turn_id as string, data.version_id as string, next))
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("message_id", next.id);
  if (updateError) throw updateError;
  await touchConversation(ownerId, conversationId);
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
      db.from("chat_job_events").select("job_id,sequence,event").eq("owner_id", ownerId).eq("conversation_id", conversationId).in("job_id", jobIds).order("sequence"),
      db.from("chat_jobs").select("job_id,status,error,final_output").eq("owner_id", ownerId).eq("conversation_id", conversationId).in("job_id", jobIds),
    ]);
    if (eventsResult.error) throw eventsResult.error;
    if (jobsResult.error) throw jobsResult.error;
    const eventsByJob = new Map<string, Array<{ sequence: number; event: ChatStreamEvent }>>();
    for (const row of eventsResult.data ?? []) {
      const eventList = eventsByJob.get(row.job_id) ?? [];
      eventList.push({ sequence: Number(row.sequence), event: row.event as ChatStreamEvent });
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
