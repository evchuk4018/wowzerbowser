import type { ChatConversation, ChatHistoryMessage } from "../../lib/chat-history";
import { applyChatStreamEvent } from "../../lib/chat-history";
import type { ChatJobResumeResponse, SequencedChatStreamEvent } from "../../lib/chat-protocol";
import { fetchChatJob, resumeChatJob } from "./chat-service";
import { waitForChatRetry } from "./chat-retry-backoff";
import type { ConversationAction } from "./conversation-state";

export type PersistedJobCandidate = {
  conversationId: string;
  message: ChatHistoryMessage;
};

export type FetchPersistedJob = (
  conversationId: string,
  jobId: string,
  after: number,
  signal?: AbortSignal,
) => Promise<ChatJobResumeResponse>;

export function findPersistedJobCandidates(conversations: ChatConversation[]): PersistedJobCandidate[] {
  return conversations.flatMap((conversation) =>
    conversation.turns.flatMap((turn) =>
      turn.versions
        .map((version) => ({ conversationId: conversation.id, message: version.assistant }))
        .filter(({ message }) => message.status === "streaming" && Boolean(message.jobId)),
    ),
  );
}

function isSequencedEvent(value: unknown): value is SequencedChatStreamEvent {
  return typeof value === "object" && value !== null
    && "sequence" in value
    && typeof value.sequence === "number";
}

function terminalAction(candidate: PersistedJobCandidate, snapshot: ChatJobResumeResponse): ConversationAction | null {
  if (snapshot.status === "completed") {
    return {
      type: "MARK_MESSAGE_COMPLETE",
      conversationId: candidate.conversationId,
      messageId: candidate.message.id,
      ...(typeof snapshot.finalOutput === "string" ? { finalOutput: snapshot.finalOutput } : {}),
      ...(snapshot.providerMetrics ? { streamMetrics: snapshot.providerMetrics } : {}),
    };
  }
  if (snapshot.status === "cancelled") return { type: "MARK_MESSAGE_CANCELLED", conversationId: candidate.conversationId, messageId: candidate.message.id };
  if (snapshot.status === "failed") return { type: "MARK_MESSAGE_ERROR", conversationId: candidate.conversationId, messageId: candidate.message.id, error: snapshot.error ?? "The response failed." };
  return null;
}

export type RecoverPersistedJobOptions = {
  candidate: PersistedJobCandidate;
  signal: AbortSignal;
  hasSession: () => Promise<boolean>;
  dispatch: (action: ConversationAction) => void;
  onConversationStreamingChange?: (conversationId: string, streaming: boolean) => void;
  fetchJob?: FetchPersistedJob;
  resumeJob?: (conversationId: string, jobId: string) => Promise<void>;
  waitForRetry?: (signal: AbortSignal, attempt: number) => Promise<boolean>;
};

/** Replay durable events and ask the server to reclaim an expired lease when necessary. */
export async function recoverPersistedJob({
  candidate,
  signal,
  hasSession,
  dispatch,
  onConversationStreamingChange,
  fetchJob = fetchChatJob,
  resumeJob = resumeChatJob,
  waitForRetry = (retrySignal, attempt) => waitForChatRetry(retrySignal, attempt),
}: RecoverPersistedJobOptions): Promise<void> {
  if (!candidate.message.jobId || signal.aborted) return;
  onConversationStreamingChange?.(candidate.conversationId, true);
  let after = candidate.message.lastSequence ?? 0;
  let currentMessage = candidate.message;
  let retryAttempt = 0;
  while (!signal.aborted) {
    let sessionReady = false;
    try { sessionReady = await hasSession(); } catch { /* retry below */ }
    if (!sessionReady) {
      if (!(await waitForRetry(signal, retryAttempt++))) return;
      continue;
    }
    try {
      await resumeJob(candidate.conversationId, candidate.message.jobId);
    } catch {
      if (!(await waitForRetry(signal, retryAttempt++))) return;
      continue;
    }
    let snapshot: ChatJobResumeResponse;
    try {
      snapshot = await fetchJob(candidate.conversationId, candidate.message.jobId, after, signal);
    } catch {
      if (!(await waitForRetry(signal, retryAttempt++))) return;
      continue;
    }
    if (signal.aborted) return;
    for (const event of snapshot.events) {
      if (!isSequencedEvent(event) || event.sequence <= after) continue;
      after = event.sequence;
      currentMessage = applyChatStreamEvent(currentMessage, event, event.sequence);
      dispatch({ type: "UPDATE_MESSAGE", conversationId: candidate.conversationId, messageId: candidate.message.id, patch: currentMessage });
    }
    if (snapshot.hasMore) {
      retryAttempt = 0;
      continue;
    }
    const terminal = terminalAction(candidate, snapshot);
    if (terminal) {
      if (signal.aborted) return;
      dispatch(terminal);
      onConversationStreamingChange?.(candidate.conversationId, false);
      return;
    }
    if (!(await waitForRetry(signal, retryAttempt++))) return;
  }
}
