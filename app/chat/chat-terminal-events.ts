import type {
  ChatJobStatus,
  ChatUsage,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";

export function chatTerminalEvents(input: {
  jobId: string;
  status: ChatJobStatus;
  error: string | null;
  usage: ChatUsage | null;
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
    events.push({ type: "done", usage: input.usage, sequence, jobId: input.jobId });
  }
  return events;
}
