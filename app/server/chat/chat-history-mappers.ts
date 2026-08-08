import { normalizeChatImageAttachments, type ChatStreamMetrics } from "../../../lib/chat-protocol";
import type { ChatDocumentAttachment } from "../../../lib/chat-document";
import type {
  ChatAssistantActivity,
  ChatHistoryMessage,
  ChatMessageStatus,
} from "../../../lib/chat-history";
import type { TodoList } from "../../../lib/todo-protocol";

export type MessageRow = {
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
  stream_metrics: unknown;
  status: ChatMessageStatus | null;
  error: string | null;
  job_id: string | null;
  last_sequence: number | string;
  trace_round: number | null;
  annotations: unknown;
  sources: unknown;
  todos: unknown;
};

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function messageFromRow(row: MessageRow): ChatHistoryMessage {
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
    ...(row.stream_metrics && typeof row.stream_metrics === "object" && !Array.isArray(row.stream_metrics)
      ? { streamMetrics: row.stream_metrics as ChatStreamMetrics }
      : {}),
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

export function messageRow(
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
    stream_metrics: message.streamMetrics ?? null,
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
