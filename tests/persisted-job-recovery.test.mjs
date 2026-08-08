import assert from "node:assert/strict";
import test from "node:test";
import {
  findPersistedJobCandidates,
  reconcileStreamingConversations,
  recoverPersistedJob,
} from "../app/chat/chat-job-recovery.ts";

const message = (id, status, jobId) => ({ id, role: "assistant", content: "", status, ...(jobId ? { jobId } : {}) });

test("finds only streaming assistant messages with durable job ids", () => {
  const conversations = [{
    id: "conversation-1",
    title: "Chat",
    turns: [{
      id: "turn-1",
      activeVersion: 0,
      versions: [
        {
          id: "version-1",
          user: { id: "user-1", role: "user", content: "hello" },
          assistant: message("assistant-1", "streaming", "job-1"),
        },
        {
          id: "version-2",
          user: { id: "user-2", role: "user", content: "retry" },
          assistant: message("assistant-2", "complete", "job-2"),
        },
        {
          id: "version-3",
          user: { id: "user-3", role: "user", content: "no job" },
          assistant: message("assistant-3", "streaming"),
        },
      ],
    }],
  }];

  assert.deepEqual(findPersistedJobCandidates(conversations), [{
    conversationId: "conversation-1",
    message: message("assistant-1", "streaming", "job-1"),
  }]);
});

const candidate = {
  conversationId: "conversation-1",
  message: message("assistant-1", "streaming", "job-1"),
};

const completedSnapshot = {
  jobId: "job-1",
  conversationId: "conversation-1",
  status: "completed",
  events: [],
  lastSequence: 0,
  error: null,
  usage: null,
  finalOutput: "done",
  createdAt: "",
  updatedAt: "",
};

test("retries when the session is temporarily unavailable", async () => {
  const controller = new AbortController();
  let sessionChecks = 0;
  const changes = [];
  const actions = [];
  await recoverPersistedJob({
    candidate,
    signal: controller.signal,
    hasSession: async () => {
      sessionChecks += 1;
      return sessionChecks !== 1;
    },
    dispatch: (action) => actions.push(action),
    onConversationStreamingChange: (_id, streaming) => changes.push(streaming),
    resumeJob: async () => undefined,
    waitForRetry: async () => true,
    fetchJob: async () => completedSnapshot,
  });
  assert.equal(sessionChecks, 2);
  assert.deepEqual(changes, [true, false]);
  assert.equal(actions[0].type, "MARK_MESSAGE_COMPLETE");
});

test("reconciles stale recovery markers against completed messages", () => {
  const conversations = [{
    id: "conversation-1",
    title: "Chat",
    turns: [{
      id: "turn-1",
      activeVersion: 0,
      versions: [{
        id: "version-1",
        user: { id: "user-1", role: "user", content: "hello" },
        assistant: message("assistant-1", "complete", "job-1"),
      }],
    }],
  }];

  assert.deepEqual(
    reconcileStreamingConversations(conversations, { "conversation-1": "persisted" }),
    {},
  );
});

test("restores response metrics when a completed job is recovered", async () => {
  const controller = new AbortController();
  const actions = [];
  await recoverPersistedJob({
    candidate,
    signal: controller.signal,
    hasSession: async () => true,
    dispatch: (action) => actions.push(action),
    resumeJob: async () => undefined,
    waitForRetry: async () => true,
    fetchJob: async () => ({
      ...completedSnapshot,
      providerMetrics: { completionTokens: 12, outputWindowMs: 600, outputTps: 20, runCost: { costUsd: 0.0004, source: "estimated" } },
    }),
  });
  assert.deepEqual(actions[0].streamMetrics, { completionTokens: 12, outputWindowMs: 600, outputTps: 20, runCost: { costUsd: 0.0004, source: "estimated" } });
});

test("retries a transient job snapshot failure instead of leaving streaming stuck", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const changes = [];
  await recoverPersistedJob({
    candidate,
    signal: controller.signal,
    hasSession: async () => true,
    dispatch: () => undefined,
    onConversationStreamingChange: (_id, streaming) => changes.push(streaming),
    resumeJob: async () => undefined,
    waitForRetry: async () => true,
    fetchJob: async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("temporary outage");
      return completedSnapshot;
    },
  });
  assert.equal(fetches, 2);
  assert.deepEqual(changes, [true, false]);
});
