"use client";

import { useEffect, useRef } from "react";
import type { ChatConversation } from "../../lib/chat-history";
import {
  findPersistedJobCandidates,
  recoverPersistedJob,
  type PersistedJobCandidate,
} from "./chat-job-recovery";
import type { ConversationAction } from "./conversation-state";

export { findPersistedJobCandidates, recoverPersistedJob } from "./chat-job-recovery";
export type { PersistedJobCandidate, RecoverPersistedJobOptions, FetchPersistedJob } from "./chat-job-recovery";

export type PersistedJobRecoveryOptions = {
  enabled: boolean;
  conversations: ChatConversation[];
  hasSession: () => Promise<boolean>;
  dispatch: (action: ConversationAction) => void;
  scopeKey?: string;
  onConversationStreamingChange?: (conversationId: string, streaming: boolean) => void;
};

export function usePersistedJobRecovery({
  enabled,
  conversations,
  hasSession,
  dispatch,
  scopeKey = "default",
  onConversationStreamingChange,
}: PersistedJobRecoveryOptions): void {
  const conversationsRef = useRef(conversations);
  const hasSessionRef = useRef(hasSession);
  const dispatchRef = useRef(dispatch);
  const streamingChangeRef = useRef(onConversationStreamingChange);
  useEffect(() => {
    conversationsRef.current = conversations;
    hasSessionRef.current = hasSession;
    dispatchRef.current = dispatch;
    streamingChangeRef.current = onConversationStreamingChange;
  }, [conversations, dispatch, hasSession, onConversationStreamingChange]);

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
          hasSession: hasSessionRef.current,
          dispatch: dispatchRef.current,
          onConversationStreamingChange: streamingChangeRef.current,
        });
      } finally {
        runningJobs.delete(jobKey);
      }
    };
    const resumePersistedJobs = async () => {
      await Promise.all(findPersistedJobCandidates(conversationsRef.current).map(resumeCandidate));
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
  }, [enabled, scopeKey]);
}
