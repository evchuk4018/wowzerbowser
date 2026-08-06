import assert from "node:assert/strict";
import test from "node:test";
import { createChatStreamState, reduceChatStreamEvent, reduceChatStreamEvents } from "../app/chat/chat-stream-reducer.ts";
import { normalizeStoredMessage } from "../app/chat/conversation-storage.ts";

const baseMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "",
  reasoning: "",
  activities: [],
  status: "streaming",
};

const event = (sequence, value) => ({ sequence, jobId: "job-1", ...value });

test("stream reducer accumulates reasoning, tool, and content events", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, { type: "round", round: 2 }), { now: 100 });
  state = reduceChatStreamEvent(state, event(2, { type: "reasoning", delta: "plan" }), { now: 110 });
  state = reduceChatStreamEvent(state, event(3, {
    type: "tool_call",
    call: { id: "call-1", name: "run_python", arguments: "{}" },
  }), { now: 120 });
  state = reduceChatStreamEvent(state, event(4, {
    type: "tool_result",
    result: { id: "call-1", name: "run_python", ok: true, stdout: "ok", stderr: "", durationMs: 2 },
  }), { now: 130 });
  state = reduceChatStreamEvent(state, event(5, { type: "content", delta: "answer" }), { now: 140 });

  assert.equal(state.message.reasoning, "plan");
  assert.equal(state.message.content, "answer");
  assert.equal(state.message.activities?.length, 3);
  assert.equal(state.message.activities?.[0].status, "complete");
  assert.equal(state.message.activities?.[1].status, "completed");
  assert.equal(state.message.activities?.[2].kind, "output");
  assert.equal(state.message.activities?.[2].content, "answer");
  assert.equal(state.waiting, false);
  assert.equal(state.message.lastSequence, 5);
});

test("error and done events preserve error status", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, { type: "error", message: "failed" }), { now: 100 });
  state = reduceChatStreamEvent(state, event(2, { type: "done", usage: null }), { now: 110 });
  assert.equal(state.message.status, "error");
  assert.equal(state.message.error, "failed");
  assert.equal(state.streamError, true);
  assert.equal(state.waiting, false);
});

test("first content event records thinking duration once", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, { type: "reasoning", delta: "x" }), {
    now: 120,
    thinkingStartedAt: 100,
  });
  state = reduceChatStreamEvent(state, event(2, { type: "content", delta: "y" }), {
    now: 150,
    thinkingStartedAt: 100,
  });
  state = reduceChatStreamEvent(state, event(3, { type: "content", delta: "z" }), {
    now: 200,
    thinkingStartedAt: 100,
  });
  assert.equal(state.message.thinkingDurationMs, 50);
  assert.equal(state.thinkingFinished, true);
});

test("reduces a frame-sized event batch with one final message state", () => {
  const state = reduceChatStreamEvents(createChatStreamState(baseMessage), [
    event(1, { type: "content", delta: "Full " }),
    event(2, { type: "content", delta: "speed" }),
    event(3, { type: "done", usage: { completionTokens: 2 } }),
  ]);
  assert.equal(state.message.content, "Full speed");
  assert.equal(state.message.lastSequence, 3);
  assert.equal(state.message.status, "complete");
});

test("retains output metrics delivered after the terminal event", () => {
  const state = reduceChatStreamEvents(createChatStreamState(baseMessage), [
    event(1, { type: "content", delta: "Answer" }),
    event(2, { type: "done", usage: { completionTokens: 12 } }),
    event(3, { type: "metrics", metrics: { completionTokens: 12, outputWindowMs: 600, outputTps: 20, runCost: { costUsd: 0.0004, source: "estimated" } } }),
  ]);
  assert.equal(state.message.status, "complete");
  assert.deepEqual(state.message.streamMetrics, { completionTokens: 12, outputWindowMs: 600, outputTps: 20, runCost: { costUsd: 0.0004, source: "estimated" } });
});

test("cancelled events finish the message without an error", () => {
  const state = reduceChatStreamEvent(
    createChatStreamState(baseMessage),
    event(1, { type: "cancelled" }),
  );
  assert.equal(state.message.status, "cancelled");
  assert.equal(state.waiting, false);
});

test("provider rounds stay in one phase until an explicit phase break", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, { type: "round", round: 1 }));
  state = reduceChatStreamEvent(state, event(2, { type: "reasoning", delta: "First phase. " }));
  state = reduceChatStreamEvent(state, event(3, { type: "round", round: 2 }));
  state = reduceChatStreamEvent(state, event(4, { type: "reasoning", delta: "Still first phase." }));
  state = reduceChatStreamEvent(state, event(5, {
    type: "phase_summary", phase: 1, summary: "Planning the first approach", revision: 2,
  }));
  const call = { id: "phase-1", name: "phase_break", arguments: '{"userUpdate":"I found a better route."}' };
  const result = { id: "phase-1", name: "phase_break", ok: true, stdout: '{"phase":2}', stderr: "" };
  state = reduceChatStreamEvent(state, event(6, {
    type: "phase_break", phase: 2, update: "I found a better route.", call, result,
  }));
  state = reduceChatStreamEvent(state, event(7, { type: "round", round: 3 }));
  state = reduceChatStreamEvent(state, event(8, { type: "reasoning", delta: "Second phase." }));

  const reasoning = state.message.activities?.filter(({ kind }) => kind === "reasoning");
  assert.deepEqual(reasoning?.map(({ phase }) => phase), [1, 1, 2]);
  assert.equal(reasoning?.[0]?.summary, "Planning the first approach");
  assert.equal(state.message.activities?.find(({ kind }) => kind === "phase_break")?.update, "I found a better route.");
  assert.equal(state.message.tracePhase, 2);
});

test("phase breaks keep streamed output between separate thinking blocks", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvents(state, [
    event(1, { type: "round", round: 1 }),
    event(2, { type: "reasoning", delta: "Plan. " }),
    event(3, { type: "content", delta: "First update. " }),
    event(4, { type: "content", delta: "Still first update." }),
    event(5, {
      type: "phase_break",
      phase: 2,
      update: "Moving on.",
      call: { id: "phase-1", name: "phase_break", arguments: "{}" },
      result: { id: "phase-1", name: "phase_break", ok: true, stdout: "", stderr: "" },
    }),
    event(6, { type: "round", round: 2 }),
    event(7, { type: "reasoning", delta: "Continue. " }),
    event(8, { type: "content", delta: "Final answer." }),
  ]);

  assert.deepEqual(state.message.activities?.map(({ kind, phase, content }) => ({ kind, phase, content })), [
    { kind: "reasoning", phase: 1, content: "Plan. " },
    { kind: "output", phase: 1, content: "First update. Still first update." },
    { kind: "phase_break", phase: 1, content: undefined },
    { kind: "reasoning", phase: 2, content: "Continue. " },
    { kind: "output", phase: 2, content: "Final answer." },
  ]);
  assert.equal(state.message.activities?.[0].status, "complete");
  assert.equal(state.message.activities?.[3].status, "complete");
});

test("phase summaries persist across tool-separated reasoning until replaced", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, { type: "reasoning", delta: "First thought." }));
  state = reduceChatStreamEvent(state, event(2, {
    type: "phase_summary", phase: 1, summary: "Planning the first approach", revision: 1,
  }));
  state = reduceChatStreamEvent(state, event(3, {
    type: "tool_call",
    call: { id: "call-1", name: "web_search", arguments: "{}" },
  }));
  state = reduceChatStreamEvent(state, event(4, { type: "reasoning", delta: "Continuing after the tool." }));

  let reasoning = state.message.activities?.filter(({ kind }) => kind === "reasoning");
  assert.equal(reasoning?.[0]?.summary, "Planning the first approach");
  assert.equal(reasoning?.[1]?.summary, undefined);

  state = reduceChatStreamEvent(state, event(5, {
    type: "phase_summary", phase: 1, summary: "Reviewing the new evidence", revision: 2,
  }));
  reasoning = state.message.activities?.filter(({ kind }) => kind === "reasoning");
  assert.deepEqual(reasoning?.map(({ summary }) => summary), [
    "Reviewing the new evidence",
    "Reviewing the new evidence",
  ]);
});

const researchPlan = {
  id: "plan-1",
  request: "Compare the evidence.",
  items: [
    { id: "scope", title: "Scope", question: "What is the scope?", focus: "Definitions" },
    { id: "evidence", title: "Evidence", question: "What is the evidence?", focus: "Primary sources" },
    { id: "uncertainty", title: "Uncertainty", question: "What remains uncertain?", focus: "Limitations" },
  ],
};

test("deep research plans create every queued subagent card in plan order", () => {
  const state = reduceChatStreamEvent(
    createChatStreamState(baseMessage),
    event(1, { type: "deep_research_plan", plan: researchPlan }),
  );
  assert.deepEqual(
    state.message.activities?.map(({ kind, taskId, title, status }) => ({ kind, taskId, title, status })),
    [
      { kind: "subagent", taskId: "scope", title: "Scope", status: "queued" },
      { kind: "subagent", taskId: "evidence", title: "Evidence", status: "queued" },
      { kind: "subagent", taskId: "uncertainty", title: "Uncertainty", status: "queued" },
    ],
  );
});

test("subagent updates are idempotent and accumulate only new summary revisions and trace entries", () => {
  let state = reduceChatStreamEvent(
    createChatStreamState(baseMessage),
    event(1, { type: "deep_research_plan", plan: researchPlan }),
  );
  const firstUpdate = {
    type: "subagent_update",
    taskId: "evidence",
    title: "Evidence",
    status: "running",
    summary: "Collecting primary sources",
    summaryRevision: 1,
    trace: [{ id: "stage-1", kind: "stage", label: "Search", status: "running" }],
  };
  state = reduceChatStreamEvent(state, event(2, firstUpdate), { now: 100 });
  state = reduceChatStreamEvent(state, event(3, firstUpdate), { now: 200 });
  state = reduceChatStreamEvent(state, event(4, {
    type: "subagent_update",
    taskId: "evidence",
    title: "Evidence",
    status: "running",
    summary: "Sources collected",
    summaryRevision: 2,
    trace: [
      { id: "stage-1", kind: "stage", label: "Search", status: "completed" },
      { id: "operation-1", kind: "operation", label: "Read source", status: "running", detail: "Primary source" },
    ],
  }), { now: 300 });
  const subagents = state.message.activities?.filter(({ kind }) => kind === "subagent");
  const evidence = subagents?.find(({ taskId }) => taskId === "evidence");

  assert.equal(subagents?.length, 3);
  assert.deepEqual(subagents?.map(({ taskId }) => taskId), ["scope", "evidence", "uncertainty"]);
  assert.equal(evidence?.status, "running");
  assert.deepEqual(evidence?.summaryHistory, [
    { revision: 1, summary: "Collecting primary sources" },
    { revision: 2, summary: "Sources collected" },
  ]);
  assert.deepEqual(evidence?.trace, [
    { id: "stage-1", kind: "stage", label: "Search", status: "completed" },
    { id: "operation-1", kind: "operation", label: "Read source", status: "running", detail: "Primary source" },
  ]);
  assert.equal(evidence?.startedAt, 100);
});

test("orchestrator updates create title-only reasoning without raw reasoning content", () => {
  let state = createChatStreamState(baseMessage);
  state = reduceChatStreamEvent(state, event(1, {
    type: "deep_research_orchestrator_update",
    status: "running",
    summary: "Coordinating research",
    summaryRevision: 1,
    trace: [{ id: "orchestrator-stage", kind: "stage", label: "Coordinate", status: "running" }],
  }), { now: 100 });
  const orchestrator = state.message.activities?.find(({ id }) => id === "deep-research-orchestrator");
  assert.equal(orchestrator?.kind, "reasoning");
  assert.equal(orchestrator?.content, "");
  assert.equal(orchestrator?.summary, "Coordinating research");
  assert.deepEqual(orchestrator?.trace, [{ id: "orchestrator-stage", kind: "stage", label: "Coordinate", status: "running" }]);
  assert.equal(state.message.reasoning, "");

  state = reduceChatStreamEvent(state, event(2, {
    type: "deep_research_orchestrator_update",
    status: "completed",
    summary: "Research coordinated",
    summaryRevision: 2,
  }), { now: 250 });
  const reasoning = state.message.activities?.filter(({ kind }) => kind === "reasoning");
  assert.equal(reasoning?.length, 1);
  assert.equal(reasoning?.[0].content, "");
  assert.equal(reasoning?.[0].status, "complete");
  assert.equal(reasoning?.[0].summaryRevision, 2);
});

test("done, error, and cancellation finalize queued and running research activities", () => {
  const researchEvents = [
    event(1, { type: "deep_research_plan", plan: researchPlan }),
    event(2, { type: "subagent_update", taskId: "scope", title: "Scope", status: "running" }),
  ];
  const done = reduceChatStreamEvents(createChatStreamState(baseMessage), [
    ...researchEvents,
    event(3, { type: "done", usage: null }),
  ], { now: 500 });
  assert.deepEqual(done.message.activities?.filter(({ kind }) => kind === "subagent").map(({ status }) => status), ["failed", "failed", "failed"]);

  const errored = reduceChatStreamEvent(
    reduceChatStreamEvents(createChatStreamState(baseMessage), researchEvents, { now: 100 }),
    event(3, { type: "error", message: "Research failed" }),
    { now: 400 },
  );
  assert.deepEqual(errored.message.activities?.filter(({ kind }) => kind === "subagent").map(({ status }) => status), ["failed", "failed", "failed"]);

  const cancelled = reduceChatStreamEvent(
    reduceChatStreamEvents(createChatStreamState(baseMessage), researchEvents, { now: 100 }),
    event(3, { type: "cancelled" }),
    { now: 400 },
  );
  assert.deepEqual(cancelled.message.activities?.filter(({ kind }) => kind === "subagent").map(({ status }) => status), ["failed", "failed", "failed"]);
});

test("replaying stored research activities freezes unfinished cards and bounds trace data", () => {
  const normalized = normalizeStoredMessage({
    role: "assistant",
    id: "assistant-research",
    content: "Report",
    activities: [{
      id: "subagent-scope",
      kind: "subagent",
      round: 1,
      phase: 1,
      taskId: "scope",
      title: "Scope",
      status: "running",
      startedAt: 100,
      trace: Array.from({ length: 140 }, (_, index) => ({
        id: `operation-${index}`,
        kind: "operation",
        label: `Operation ${index}`,
        status: "running",
      })),
    }],
  }, { now: 1_000 });
  const activity = normalized?.activities?.[0];
  assert.equal(activity?.kind, "subagent");
  assert.equal(activity?.status, "failed");
  assert.equal(activity?.durationMs, 900);
  assert.equal(activity?.trace?.length, 128);
});
