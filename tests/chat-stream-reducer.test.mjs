import assert from "node:assert/strict";
import test from "node:test";
import { createChatStreamState, reduceChatStreamEvent } from "../app/chat/chat-stream-reducer.ts";

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
  assert.equal(state.message.activities?.length, 2);
  assert.equal(state.message.activities?.[0].status, "complete");
  assert.equal(state.message.activities?.[1].status, "completed");
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

