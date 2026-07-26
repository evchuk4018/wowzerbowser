import type {
  ChatArtifact,
  ChatImageAttachment,
  ChatToolCall,
  ChatToolResult,
  ChatStreamEvent,
} from "./chat-protocol";

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
  kind: "python" | "web" | "image";
  round: number;
  call: ChatToolCall;
  result?: ChatToolResult;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
};

export type ChatPythonActivity = Omit<ChatToolActivity, "kind"> & { kind: "python" };
/** Compatibility shape accepted by the existing activity timeline. */
export type ChatWebActivity = Omit<ChatToolActivity, "kind"> & { kind: "web" | "image" };
export type ChatImageActivity = Omit<ChatToolActivity, "kind"> & { kind: "image" };
type ChatPersistedWebActivity = Omit<ChatToolActivity, "kind"> & { kind: "web" };
export type ChatAssistantActivity = ChatReasoningActivity | ChatPythonActivity | ChatPersistedWebActivity | ChatImageActivity;

export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Private storage metadata only; never contains image bytes or URLs. */
  attachments?: ChatImageAttachment[];
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
  return { ...base, kind: "web" };
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
