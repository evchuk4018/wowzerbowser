import type {
  ChatArtifact,
  ChatImageAttachment,
  ChatDocumentAttachment,
  ChatToolCall,
  ChatToolResult,
  ChatStreamEvent,
} from "./chat-protocol";
import type { ChatCitation, ChatSource } from "./chat-citations";

export type ChatMessageStatus = "streaming" | "complete" | "error" | "cancelled";

export type ChatReasoningActivity = {
  id: string;
  kind: "reasoning";
  round: number;
  content: string;
  status: "running" | "complete";
  startedAt?: number;
  durationMs?: number;
};

export type ChatToolActivity = {
  id: string;
  kind: "python" | "web" | "image" | "document";
  round: number;
  call: ChatToolCall;
  result?: ChatToolResult;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
};

export type ChatPythonActivity = Omit<ChatToolActivity, "kind"> & { kind: "python" };
export type ChatWebActivity = Omit<ChatToolActivity, "kind"> & { kind: "web" };
export type ChatImageActivity = Omit<ChatToolActivity, "kind"> & { kind: "image" };
export type ChatDocumentActivity = Omit<ChatToolActivity, "kind"> & { kind: "document" };
export type ChatAssistantActivity = ChatReasoningActivity | ChatPythonActivity | ChatWebActivity | ChatImageActivity | ChatDocumentActivity;

export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Private storage metadata only; never contains image bytes or URLs. */
  attachments?: ChatImageAttachment[];
  documents?: ChatDocumentAttachment[];
  reasoning?: string;
  activities?: ChatAssistantActivity[];
  artifacts?: ChatArtifact[];
  thinkingEnabled?: boolean;
  thinkingDurationMs?: number;
  status?: ChatMessageStatus;
  error?: string;
  jobId?: string;
  lastSequence?: number;
  traceRound?: number;
  annotations?: ChatCitation[];
  sources?: ChatSource[];
};

export type ChatTurnVersion = {
  id: string;
  user: ChatHistoryMessage;
  assistant: ChatHistoryMessage;
};

export type ChatConversationTurn = {
  id: string;
  versions: ChatTurnVersion[];
  activeVersion: number;
};

export type ChatConversation = {
  id: string;
  title: string;
  turns: ChatConversationTurn[];
};

export type ChatConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  hasMessages: boolean;
  isStreaming: boolean;
};

export type ChatTraceState = Pick<
  ChatHistoryMessage,
  "content" | "reasoning" | "activities" | "artifacts" | "lastSequence" | "traceRound"
>;

const finishRunningActivities = (
  activities: ChatAssistantActivity[] | undefined,
  failRunningTools: boolean,
  finishedAt: number,
): ChatAssistantActivity[] | undefined => activities?.map((activity) => {
  if (activity.status !== "running") return activity;
  const durationMs = activity.durationMs ?? (activity.startedAt === undefined
    ? undefined
    : Math.max(0, finishedAt - activity.startedAt));
  if (activity.kind === "reasoning") return { ...activity, status: "complete", durationMs };
  return failRunningTools ? { ...activity, status: "failed", durationMs } : activity;
});

function activityForTool(call: ChatToolCall, round: number, startedAt: number): ChatAssistantActivity {
  const base = {
    id: call.id,
    round,
    call,
    status: "running",
    startedAt,
  } as const;
  if (call.name === "run_python") return { ...base, kind: "python" };
  if (call.name === "inspect_image") return { ...base, kind: "image" };
  if (["inspect_pdf_editability", "edit_source_backed_document", "edit_pdf", "compare_document_revisions"].includes(call.name)) return { ...base, kind: "document" };
  return { ...base, kind: legacyToolKind(call) };
}

function legacyToolKind(call: ChatToolCall): "python" | "web" {
  return ({ kind: call.name === "run_python" ? "python" : "web" } as const).kind;
}

export function applyChatStreamEvent(
  message: ChatHistoryMessage,
  event: ChatStreamEvent,
  sequence: number,
  now = Date.now(),
): ChatHistoryMessage {
  const next: ChatHistoryMessage = {
    ...message,
    lastSequence: sequence,
  };
  if (event.type === "round") {
    next.traceRound = event.round;
    next.activities = finishRunningActivities(next.activities, false, now);
  } else if (event.type === "reasoning") {
    const activities = [...(next.activities ?? [])];
    const latest = activities.at(-1);
    const round = next.traceRound ?? latest?.round ?? 1;
    if (latest?.kind === "reasoning" && latest.round === round && latest.status === "running") {
      activities[activities.length - 1] = { ...latest, content: `${latest.content}${event.delta}` };
    } else {
      activities.push({
        id: `reasoning-${sequence}`,
        kind: "reasoning",
        round,
        content: event.delta,
        status: "running",
        startedAt: now,
      });
    }
    next.reasoning = `${next.reasoning ?? ""}${event.delta}`;
    next.activities = activities;
  } else if (event.type === "tool_call") {
    next.activities = [
      ...(finishRunningActivities(next.activities, false, now) ?? []),
      activityForTool(event.call, next.traceRound ?? 1, now),
    ];
  } else if (event.type === "tool_result") {
    next.activities = next.activities?.map((activity) =>
      activity.kind !== "reasoning" && activity.call.id === event.result.id
        ? {
            ...activity,
            result: event.result,
            status: event.result.ok ? "completed" : "failed",
            durationMs: event.result.durationMs ?? (activity.startedAt === undefined
              ? undefined
              : Math.max(0, now - activity.startedAt)),
          }
        : activity,
    );
    next.artifacts = [
      ...(next.artifacts ?? []),
      ...(event.result.artifacts ?? []).filter((artifact) => !(next.artifacts ?? []).some((item) => item.id === artifact.id)),
    ];
    const web = event.result.web;
    const resultSources = web?.kind === "search" ? web.results : web?.kind === "page" ? [web.source] : [];
    if (resultSources.length) {
      const existing = new Map((next.sources ?? []).map((source) => [source.id, source]));
      for (const source of resultSources) existing.set(source.id, source);
      next.sources = [...existing.values()];
    }
  } else if (event.type === "annotations") {
    const known = new Set((event.sources ?? []).map((source) => source.id));
    next.sources = event.sources.filter((source) => known.has(source.id));
    next.annotations = event.annotations.filter((annotation) => annotation.sourceIds.some((id) => known.has(id)));
  } else if (event.type === "artifact") {
    next.artifacts = (next.artifacts ?? []).some((artifact) => artifact.id === event.artifact.id)
      ? next.artifacts
      : [...(next.artifacts ?? []), event.artifact];
  } else if (event.type === "content") {
    next.content = `${next.content}${event.delta}`;
    next.activities = finishRunningActivities(next.activities, true, now);
  } else if (event.type === "error") {
    next.error = event.message;
    next.status = "error";
    next.activities = finishRunningActivities(next.activities, true, now);
  } else if (event.type === "cancelled") {
    next.status = "cancelled";
    next.activities = finishRunningActivities(next.activities, true, now);
  } else if (event.type === "done") {
    next.activities = finishRunningActivities(next.activities, true, now);
  }
  return next;
}

export function finalizeChatHistoryMessage(
  message: ChatHistoryMessage,
  status: ChatMessageStatus,
  values: { error?: string | null; finalOutput?: string | null } = {},
  now = Date.now(),
): ChatHistoryMessage {
  const reasoningDuration = (message.activities ?? [])
    .filter((activity): activity is ChatReasoningActivity => activity.kind === "reasoning")
    .reduce((total, activity) => total + (activity.durationMs ?? 0), 0);
  return {
    ...message,
    content: values.finalOutput ?? message.content,
    status,
    error: values.error ?? message.error,
    ...(message.thinkingDurationMs === undefined && reasoningDuration > 0
      ? { thinkingDurationMs: reasoningDuration }
      : {}),
    activities: finishRunningActivities(message.activities, true, now),
  };
}
