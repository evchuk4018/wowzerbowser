import { CHAT_RESEARCH_TRACE_MAX_ENTRIES, normalizeChatResearchTrace } from "./chat-protocol";
import type {
  ChatArtifact,
  ChatImageAttachment,
  ChatDocumentAttachment,
  ChatToolCall,
  ChatToolResult,
  ChatStreamEvent,
  ChatStreamMetrics,
  DeepResearchPlan,
  ChatResearchTraceEntry,
} from "./chat-protocol";
import type { ChatCitation, ChatSource } from "./chat-citations";
import type { TodoList } from "./todo-protocol";
import type { ConnectorApprovalSummary } from "./connector-protocol";

export type ChatMessageStatus = "streaming" | "complete" | "error" | "cancelled";

export type ChatReasoningActivity = {
  id: string;
  kind: "reasoning";
  round: number;
  phase: number;
  content: string;
  summary?: string;
  summaryRevision?: number;
  trace?: ChatResearchTraceEntry[];
  status: "running" | "complete";
  startedAt?: number;
  durationMs?: number;
};

export type ChatOutputActivity = {
  id: string;
  kind: "output";
  round: number;
  phase: number;
  content: string;
  status: "complete";
};

export type ChatToolActivity = {
  id: string;
  kind: "python" | "web" | "image" | "document";
  round: number;
  phase: number;
  call: ChatToolCall;
  result?: ChatToolResult;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
};

export type ChatPhaseBreakActivity = {
  id: string;
  kind: "phase_break";
  round: number;
  phase: number;
  nextPhase: number;
  update?: string;
  call: ChatToolCall;
  result: ChatToolResult;
  status: "completed";
};

export type ChatPythonActivity = Omit<ChatToolActivity, "kind"> & { kind: "python" };
export type ChatWebActivity = Omit<ChatToolActivity, "kind"> & { kind: "web" };
export type ChatImageActivity = Omit<ChatToolActivity, "kind"> & { kind: "image" };
export type ChatDocumentActivity = Omit<ChatToolActivity, "kind"> & { kind: "document" };
export type ChatResearchSummaryRevision = {
  revision: number;
  summary: string;
};

export type ChatSubagentActivity = {
  id: string;
  kind: "subagent";
  round: number;
  phase: number;
  taskId: string;
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  summary?: string;
  summaryHistory?: ChatResearchSummaryRevision[];
  trace?: ChatResearchTraceEntry[];
  startedAt?: number;
  durationMs?: number;
};

export type ChatAssistantActivity = ChatReasoningActivity | ChatOutputActivity | ChatPythonActivity | ChatWebActivity | ChatImageActivity | ChatDocumentActivity | ChatPhaseBreakActivity | ChatSubagentActivity;

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
  streamMetrics?: ChatStreamMetrics;
  status?: ChatMessageStatus;
  error?: string;
  jobId?: string;
  lastSequence?: number;
  traceRound?: number;
  tracePhase?: number;
  annotations?: ChatCitation[];
  sources?: ChatSource[];
  todos?: TodoList;
  connectorApproval?: ConnectorApprovalSummary;
  deepResearchPlan?: DeepResearchPlan;
};

export type ChatTurnVersion = {
  id: string;
  user: ChatHistoryMessage;
  assistant: ChatHistoryMessage;
  /** The version in the preceding turn that produced this version. */
  parentVersionId?: string | null;
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
  todos?: TodoList;
};

/**
 * Project a conversation onto the one branch selected by its active versions.
 *
 * Older history did not record lineage, so it continues to use the legacy
 * linear projection until a new version gives the conversation lineage data.
 * The returned turns contain only versions that can follow the selected
 * version in the preceding turn; stored alternate branches remain untouched.
 */
export function getActiveConversationTurns(
  conversation: ChatConversation,
): ChatConversationTurn[] {
  const hasLineage = conversation.turns.some((turn) =>
    turn.versions.some((version) => typeof version.parentVersionId === "string"),
  );
  const activeTurns: ChatConversationTurn[] = [];
  let parentVersionId: string | null = null;

  for (const turn of conversation.turns) {
    const candidates = hasLineage
      ? turn.versions.filter((version) => (version.parentVersionId ?? null) === parentVersionId)
      : turn.versions;
    if (!candidates.length) break;

    const preferred = turn.versions[turn.activeVersion];
    const preferredIndex = preferred
      ? candidates.findIndex((version) => version.id === preferred.id)
      : -1;
    const activeVersion = preferredIndex >= 0 ? preferredIndex : candidates.length - 1;
    const selected = candidates[activeVersion];
    activeTurns.push({ ...turn, versions: candidates, activeVersion });
    parentVersionId = selected.id;
  }

  return activeTurns;
}

export type ChatConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  hasMessages: boolean;
  isStreaming: boolean;
};

export type ChatTraceState = Pick<
  ChatHistoryMessage,
  "content" | "reasoning" | "activities" | "artifacts" | "lastSequence" | "traceRound" | "tracePhase"
>;

const finishRunningActivities = (
  activities: ChatAssistantActivity[] | undefined,
  failRunningTools: boolean,
  finishedAt: number,
): ChatAssistantActivity[] | undefined => activities?.map((activity) => {
  if (activity.kind === "subagent" && failRunningTools && (activity.status === "queued" || activity.status === "running")) {
    const durationMs = activity.durationMs ?? (activity.startedAt === undefined
      ? undefined
      : Math.max(0, finishedAt - activity.startedAt));
    return { ...activity, status: "failed", durationMs };
  }
  if (activity.kind === "output" || activity.status !== "running") return activity;
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
    phase: 1,
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

const ORCHESTRATOR_ACTIVITY_ID = "deep-research-orchestrator";
const MAX_RESEARCH_SUMMARY_LENGTH = 4_000;
const MAX_RESEARCH_SUMMARY_HISTORY = 128;

function safeResearchText(value: string): string {
  return value.slice(0, MAX_RESEARCH_SUMMARY_LENGTH);
}

function validResearchRevision(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function mergeResearchTrace(
  current: ChatResearchTraceEntry[] | undefined,
  incoming: unknown,
): ChatResearchTraceEntry[] | undefined {
  const existing = normalizeChatResearchTrace(current);
  const additions = normalizeChatResearchTrace(incoming);
  if (!additions.length) return existing.length ? existing : current;
  const merged = existing.slice(0, CHAT_RESEARCH_TRACE_MAX_ENTRIES);
  const positions = new Map(merged.map((entry, index) => [entry.id, index]));
  for (const entry of additions) {
    const position = positions.get(entry.id);
    if (position === undefined) {
      merged.push(entry);
      positions.set(entry.id, merged.length - 1);
      if (merged.length > CHAT_RESEARCH_TRACE_MAX_ENTRIES) {
        const removed = merged.shift();
        if (removed) positions.delete(removed.id);
        for (const [id, index] of positions) positions.set(id, index - 1);
      }
    } else {
      merged[position] = entry;
    }
  }
  return merged;
}

function mergeSubagentSummary(
  activity: ChatSubagentActivity,
  summary: string | undefined,
  revision: number | undefined,
): ChatSubagentActivity {
  if (summary === undefined) return activity;
  const safeSummary = safeResearchText(summary);
  if (!validResearchRevision(revision)) {
    return activity.summary === safeSummary ? activity : { ...activity, summary: safeSummary };
  }
  const history = activity.summaryHistory ?? [];
  const highestRevision = history.reduce((highest, item) => Math.max(highest, item.revision), -1);
  if (history.some((item) => item.revision === revision) || revision <= highestRevision) return activity;
  return {
    ...activity,
    summary: safeSummary,
    summaryHistory: [...history, { revision, summary: safeSummary }].slice(-MAX_RESEARCH_SUMMARY_HISTORY),
  };
}

function orderSubagentActivities(
  activities: ChatAssistantActivity[],
  plan: DeepResearchPlan | undefined,
): ChatAssistantActivity[] {
  if (!plan) return activities;
  const planOrder = new Map(plan.items.map((item, index) => [item.id, index]));
  const subagents = activities
    .map((activity, index) => ({ activity, index }))
    .filter((entry): entry is { activity: ChatSubagentActivity; index: number } => entry.activity.kind === "subagent")
    .sort((left, right) => {
      const leftOrder = planOrder.get(left.activity.taskId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = planOrder.get(right.activity.taskId) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ activity }) => activity);
  let subagentIndex = 0;
  return activities.map((activity) => activity.kind === "subagent" ? subagents[subagentIndex++] : activity);
}

function queuedSubagentActivity(
  taskId: string,
  title: string,
  round: number,
  phase: number,
): ChatSubagentActivity {
  return {
    id: `subagent-${taskId}`,
    kind: "subagent",
    round,
    phase,
    taskId,
    title: safeResearchText(title),
    status: "queued",
  };
}

function applyResearchPlanActivities(
  activities: ChatAssistantActivity[] | undefined,
  plan: DeepResearchPlan,
  round: number,
  phase: number,
): ChatAssistantActivity[] {
  const next = [...(activities ?? [])];
  for (const item of plan.items) {
    if (!next.some((activity) => activity.kind === "subagent" && activity.taskId === item.id)) {
      next.push(queuedSubagentActivity(item.id, item.title, round, phase));
    }
  }
  return orderSubagentActivities(next, plan);
}

function applySubagentUpdate(
  activities: ChatAssistantActivity[] | undefined,
  event: Extract<ChatStreamEvent, { type: "subagent_update" }>,
  round: number,
  phase: number,
  now: number,
  plan: DeepResearchPlan | undefined,
): ChatAssistantActivity[] {
  const next = [...(activities ?? [])];
  const index = next.findIndex((activity) => activity.kind === "subagent" && activity.taskId === event.taskId);
  const previous = index >= 0 ? next[index] as ChatSubagentActivity : queuedSubagentActivity(event.taskId, event.title, round, phase);
  let activity: ChatSubagentActivity = {
    ...previous,
    title: safeResearchText(event.title),
    status: event.status,
    ...(event.status === "running" && previous.startedAt === undefined ? { startedAt: now } : {}),
    ...(event.status !== "running" && event.status !== "queued" && previous.durationMs === undefined && previous.startedAt !== undefined
      ? { durationMs: Math.max(0, now - previous.startedAt) }
      : {}),
  };
  activity = mergeSubagentSummary(activity, event.summary, event.summaryRevision);
  const trace = mergeResearchTrace(activity.trace, event.trace);
  if (trace) activity = { ...activity, trace };
  if (index >= 0) next[index] = activity;
  else next.push(activity);
  return orderSubagentActivities(next, plan);
}

function applyOrchestratorUpdate(
  activities: ChatAssistantActivity[] | undefined,
  event: Extract<ChatStreamEvent, { type: "deep_research_orchestrator_update" }>,
  round: number,
  phase: number,
  now: number,
): ChatAssistantActivity[] {
  const next = [...(activities ?? [])];
  const index = next.findIndex((activity) => activity.kind === "reasoning" && activity.id === ORCHESTRATOR_ACTIVITY_ID);
  const previous = index >= 0 ? next[index] as ChatReasoningActivity : undefined;
  const summaryRevision = validResearchRevision(event.summaryRevision)
    && (previous?.summaryRevision === undefined || event.summaryRevision > previous.summaryRevision)
    ? event.summaryRevision
    : previous?.summaryRevision;
  const summary = event.summary !== undefined
    && (event.summaryRevision === undefined || previous?.summaryRevision === undefined || event.summaryRevision > previous.summaryRevision)
    ? safeResearchText(event.summary)
    : previous?.summary;
  const status = event.status === "running" ? "running" : "complete";
  const activity: ChatReasoningActivity = {
    id: ORCHESTRATOR_ACTIVITY_ID,
    kind: "reasoning",
    round: previous?.round ?? round,
    phase: previous?.phase ?? phase,
    content: "",
    status,
    ...(summary === undefined ? {} : { summary }),
    ...(summaryRevision === undefined ? {} : { summaryRevision }),
    ...(previous?.startedAt !== undefined || event.status === "running" ? { startedAt: previous?.startedAt ?? now } : {}),
    ...(status === "complete" && previous?.startedAt !== undefined
      ? { durationMs: previous.durationMs ?? Math.max(0, now - previous.startedAt) }
      : previous?.durationMs === undefined ? {} : { durationMs: previous.durationMs }),
  };
  const trace = mergeResearchTrace(previous?.trace, event.trace);
  if (trace) activity.trace = trace;
  if (index >= 0) next[index] = activity;
  else next.push(activity);
  return next;
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
    const phase = next.tracePhase ?? 1;
    if (latest?.kind === "reasoning" && latest.id !== ORCHESTRATOR_ACTIVITY_ID && latest.phase === phase && latest.status === "running") {
      activities[activities.length - 1] = { ...latest, content: `${latest.content}${event.delta}` };
    } else {
      activities.push({
        id: `reasoning-${sequence}`,
        kind: "reasoning",
        round,
        phase,
        content: event.delta,
        status: "running",
        startedAt: now,
      });
    }
    next.reasoning = `${next.reasoning ?? ""}${event.delta}`;
    next.activities = activities;
  } else if (event.type === "todo_update") {
    next.todos = event.todos;
  } else if (event.type === "deep_research_plan") {
    next.deepResearchPlan = event.plan;
    next.activities = applyResearchPlanActivities(
      next.activities,
      event.plan,
      next.traceRound ?? 1,
      next.tracePhase ?? 1,
    );
  } else if (event.type === "subagent_update") {
    next.activities = applySubagentUpdate(
      next.activities,
      event,
      next.traceRound ?? 1,
      next.tracePhase ?? 1,
      now,
      next.deepResearchPlan,
    );
  } else if (event.type === "deep_research_orchestrator_update") {
    next.activities = applyOrchestratorUpdate(
      next.activities,
      event,
      next.traceRound ?? 1,
      next.tracePhase ?? 1,
      now,
    );
  } else if (event.type === "phase_summary") {
    next.activities = next.activities?.map((activity) =>
      activity.kind === "reasoning" && activity.id !== ORCHESTRATOR_ACTIVITY_ID && activity.phase === event.phase && (activity.summaryRevision ?? -1) <= event.revision
        ? { ...activity, summary: event.summary, summaryRevision: event.revision }
        : activity,
    );
  } else if (event.type === "phase_break") {
    next.activities = [
      ...(finishRunningActivities(next.activities, false, now) ?? []),
      {
        id: event.call.id,
        kind: "phase_break",
        round: next.traceRound ?? 1,
        phase: Math.max(1, event.phase - 1),
        nextPhase: event.phase,
        ...(event.update ? { update: event.update } : {}),
        call: event.call,
        result: event.result,
        status: "completed",
      },
    ];
    next.tracePhase = event.phase;
  } else if (event.type === "tool_call") {
    const activity = activityForTool(event.call, next.traceRound ?? 1, now);
    next.activities = [
      ...(finishRunningActivities(next.activities, false, now) ?? []),
      { ...activity, phase: next.tracePhase ?? 1 },
    ];
  } else if (event.type === "tool_result") {
    next.connectorApproval = undefined;
    next.activities = next.activities?.map((activity) =>
      activity.kind !== "reasoning" && activity.kind !== "output" && activity.kind !== "phase_break" && activity.kind !== "subagent" && activity.call.id === event.result.id
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
    const activities = [...(next.activities ?? [])];
    const latest = activities.at(-1);
    const round = next.traceRound ?? latest?.round ?? 1;
    const phase = next.tracePhase ?? latest?.phase ?? 1;
    if (event.delta && latest?.kind === "output" && latest.round === round && latest.phase === phase) {
      activities[activities.length - 1] = { ...latest, content: `${latest.content}${event.delta}` };
    } else if (event.delta) {
      activities.push({
        id: `output-${sequence}`,
        kind: "output",
        round,
        phase,
        content: event.delta,
        status: "complete",
      });
    }
    next.content = `${next.content}${event.delta}`;
    next.activities = finishRunningActivities(activities, true, now);
  } else if (event.type === "error") {
    next.error = event.message;
    next.status = "error";
    next.activities = finishRunningActivities(next.activities, true, now);
  } else if (event.type === "cancelled") {
    next.status = "cancelled";
    next.activities = finishRunningActivities(next.activities, true, now);
  } else if (event.type === "done") {
    next.activities = finishRunningActivities(next.activities, true, now);
    if (event.runCost) {
      next.streamMetrics = {
        completionTokens: next.streamMetrics?.completionTokens ?? null,
        outputWindowMs: next.streamMetrics?.outputWindowMs ?? null,
        outputTps: next.streamMetrics?.outputTps ?? null,
        runCost: event.runCost,
      };
    }
  } else if (event.type === "metrics") {
    next.streamMetrics = event.metrics;
  } else if (event.type === "connector_approval") {
    next.connectorApproval = event.approval;
  }
  return next;
}

export function finalizeChatHistoryMessage(
  message: ChatHistoryMessage,
  status: ChatMessageStatus,
  values: { error?: string | null; finalOutput?: string | null; streamMetrics?: ChatStreamMetrics | null } = {},
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
    ...(values.streamMetrics ? { streamMetrics: values.streamMetrics } : {}),
    ...(message.thinkingDurationMs === undefined && reasoningDuration > 0
      ? { thinkingDurationMs: reasoningDuration }
      : {}),
    activities: finishRunningActivities(message.activities, true, now),
  };
}
