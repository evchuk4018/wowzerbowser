"use client";

import { useEffect, useRef } from "react";
import type { ChatConversation, ChatHistoryMessage } from "../../lib/chat-history";
import { applyChatStreamEvent } from "../../lib/chat-history";
import type { ChatJobResumeResponse, SequencedChatStreamEvent } from "../../lib/chat-protocol";
import { fetchChatJob } from "./chat-service";
import type { ConversationAction } from "./conversation-state";

export type PersistedJobCandidate = {
  conversationId: string;
  message: ChatHistoryMessage;
};

export type PersistedJobRecoveryOptions = {
  /** Start scanning once the initial conversation load has completed. */
  enabled: boolean;
  conversations: ChatConversation[];
  getAccessToken: () => Promise<string | null>;
  dispatch: (action: ConversationAction) => void;
  /** A stable owner/user key causes a fresh scan after account changes. */
  scopeKey?: string;
  /** Keep the workspace's conversation-level streaming indicator in sync. */
  onConversationStreamingChange?: (conversationId: string, streaming: boolean) => void;
  pollIntervalMs?: number;
};

export type FetchPersistedJob = (
  conversationId: string,
  jobId: string,
  after: number,
  accessToken: string,
  signal?: AbortSignal,
) => Promise<ChatJobResumeResponse>;

/** Find assistant messages whose durable jobs are still queued or running. */
export function findPersistedJobCandidates(
  conversations: ChatConversation[],
): PersistedJobCandidate[] {
  return conversations.flatMap((conversation) =>
    conversation.turns.flatMap((turn) =>
      turn.versions
        .map((version) => ({ conversationId: conversation.id, message: version.assistant }))
        .filter(({ message }) => message.status === "streaming" && Boolean(message.jobId)),
    ),
  );
}

function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(true), Math.max(0, milliseconds));
    const finish = (continuePolling: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(continuePolling);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isSequencedEvent(value: unknown): value is SequencedChatStreamEvent {
  return typeof value === "object" && value !== null
    && "sequence" in value
    && typeof value.sequence === "number";
}

function terminalAction(
  candidate: PersistedJobCandidate,
  snapshot: ChatJobResumeResponse,
): ConversationAction | null {
  if (snapshot.status === "completed") {
    return {
      type: "MARK_MESSAGE_COMPLETE",
      conversationId: candidate.conversationId,
      messageId: candidate.message.id,
      ...(typeof snapshot.finalOutput === "string" ? { finalOutput: snapshot.finalOutput } : {}),
    };
  }
  if (snapshot.status === "cancelled") {
    return {
      type: "MARK_MESSAGE_CANCELLED",
      conversationId: candidate.conversationId,
      messageId: candidate.message.id,
    };
  }
  if (snapshot.status === "failed") {
    return {
      type: "MARK_MESSAGE_ERROR",
      conversationId: candidate.conversationId,
      messageId: candidate.message.id,
      error: snapshot.error ?? "The response failed.",
    };
  }
  return null;
}

export type RecoverPersistedJobOptions = {
  candidate: PersistedJobCandidate;
  signal: AbortSignal;
  getAccessToken: () => Promise<string | null>;
  dispatch: (action: ConversationAction) => void;
  onConversationStreamingChange?: (conversationId: string, streaming: boolean) => void;
  pollIntervalMs: number;
  fetchJob?: FetchPersistedJob;
};

/** Replay one durable job, retrying auth and transient fetch failures. */
export async function recoverPersistedJob({
  candidate,
  signal,
  getAccessToken,
  dispatch,
  onConversationStreamingChange,
  pollIntervalMs,
  fetchJob = fetchChatJob,
}: RecoverPersistedJobOptions): Promise<void> {
  if (!candidate.message.jobId || signal.aborted) return;
  onConversationStreamingChange?.(candidate.conversationId, true);
  let after = candidate.message.lastSequence ?? 0;
  let currentMessage = candidate.message;
  while (!signal.aborted) {
    let accessToken: string | null = null;
    try {
      accessToken = await getAccessToken();
    } catch {
      // A temporary auth read failure is retried below without changing the
      // durable job's status.
    }
    if (!accessToken) {
      if (!(await waitForPoll(signal, pollIntervalMs))) return;
      continue;
    }

    let snapshot: ChatJobResumeResponse;
    try {
      snapshot = await fetchJob(
        candidate.conversationId,
        candidate.message.jobId,
        after,
        accessToken,
        signal,
      );
    } catch {
      // A transient fetch failure should not mark a durable job failed. Keep
      // the indicator active and retry on the normal polling cadence.
      if (!(await waitForPoll(signal, pollIntervalMs))) return;
      continue;
    }
    if (signal.aborted) return;

    for (const event of snapshot.events) {
      if (!isSequencedEvent(event) || event.sequence <= after) continue;
      after = event.sequence;
      currentMessage = applyChatStreamEvent(currentMessage, event, event.sequence);
      dispatch({
        type: "UPDATE_MESSAGE",
        conversationId: candidate.conversationId,
        messageId: candidate.message.id,
        patch: currentMessage,
      });
    }

    const terminal = terminalAction(candidate, snapshot);
    if (terminal) {
      if (!signal.aborted) {
        dispatch(terminal);
        onConversationStreamingChange?.(candidate.conversationId, false);
      }
      return;
    }

    if (!(await waitForPoll(signal, pollIntervalMs))) return;
  }
}

/**
 * Resume server-owned jobs after a reload or visibility transition.
 *
 * Normal generation remains responsible for its own stream. This hook only
 * replays durable events that already exist on the server and dispatches data
 * actions into the conversation reducer.
 */
export function usePersistedJobRecovery({
  enabled,
  conversations,
  getAccessToken,
  dispatch,
  scopeKey = "default",
  onConversationStreamingChange,
  pollIntervalMs = 750,
}: PersistedJobRecoveryOptions): void {
  const conversationsRef = useRef(conversations);
  const getAccessTokenRef = useRef(getAccessToken);
  const dispatchRef = useRef(dispatch);
  const streamingChangeRef = useRef(onConversationStreamingChange);
  useEffect(() => {
    conversationsRef.current = conversations;
    getAccessTokenRef.current = getAccessToken;
    dispatchRef.current = dispatch;
    streamingChangeRef.current = onConversationStreamingChange;
  }, [conversations, dispatch, getAccessToken, onConversationStreamingChange]);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const runningJobs = new Set<string>();

    const resumeCandidate = async (candidate: PersistedJobCandidate) => {
      const jobKey = `${candidate.conversationId}:${candidate.message.jobId}`;
      if (!candidate.message.jobId || runningJobs.has(jobKey)) return;
      runningJobs.add(jobKey);
      try {
        await recoverPersistedJob({
          candidate,
          signal: controller.signal,
          getAccessToken: getAccessTokenRef.current,
          dispatch: dispatchRef.current,
          onConversationStreamingChange: streamingChangeRef.current,
          pollIntervalMs,
        });
      } finally {
        runningJobs.delete(jobKey);
      }
    };

    const resumePersistedJobs = async () => {
      const candidates = findPersistedJobCandidates(conversationsRef.current);
      await Promise.all(candidates.map((candidate) => resumeCandidate(candidate)));
    };

    void resumePersistedJobs();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void resumePersistedJobs();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, scopeKey, pollIntervalMs]);
}
