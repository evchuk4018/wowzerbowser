import type {
  ChatJobStatus,
  ChatStreamMetrics,
  ChatUsage,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";

export function chatTerminalEvents(input: {
  jobId: string;
  status: ChatJobStatus;
  error: string | null;
  usage: ChatUsage | null;
  providerMetrics?: ChatStreamMetrics | null;
  after: number;
  sawError: boolean;
  sawDone: boolean;
}): SequencedChatStreamEvent[] {
  let sequence = input.after;
  const events: SequencedChatStreamEvent[] = [];
  if (input.status === "failed" && !input.sawError) {
    sequence += 1;
    events.push({
      type: "error",
      message: input.error ?? "Generation failed.",
      sequence,
      jobId: input.jobId,
    });
  } else if (input.status === "cancelled") {
    sequence += 1;
    events.push({ type: "cancelled", sequence, jobId: input.jobId });
  }
  if (input.status !== "cancelled" && !input.sawDone) {
    sequence += 1;
    events.push({
      type: "done",
      usage: input.usage,
      ...(input.providerMetrics?.runCost ? { runCost: input.providerMetrics.runCost } : {}),
      sequence,
      jobId: input.jobId,
    });
  }
  if (input.providerMetrics && (
    Object.values(input.providerMetrics).some((value) => typeof value === "number" && Number.isFinite(value))
    || input.providerMetrics.runCost !== undefined
  )) {
    sequence += 1;
    events.push({ type: "metrics", metrics: input.providerMetrics, sequence, jobId: input.jobId });
  }
  return events;
}
