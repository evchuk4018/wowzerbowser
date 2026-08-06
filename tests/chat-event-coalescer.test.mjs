import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventCoalescer } from "../app/server/chat/chat-event-coalescer.ts";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("coalesces adjacent reasoning and content deltas on a timer", async () => {
  const events = [];
  const coalescer = createChatEventCoalescer((event) => events.push(event), { flushIntervalMs: 10, maxTextLength: 100 });

  await coalescer.enqueue({ type: "reasoning", delta: "plan " });
  await coalescer.enqueue({ type: "reasoning", delta: "first" });
  await wait(20);

  assert.deepEqual(events, [{ type: "reasoning", delta: "plan first" }]);
  await coalescer.drain();
});

test("coalesces adjacent orchestrator reasoning while preserving the latest structural boundary", async () => {
  const events = [];
  const coalescer = createChatEventCoalescer((event) => events.push(event), { flushIntervalMs: 10, maxTextLength: 100 });

  await coalescer.enqueue({ type: "deep_research_orchestrator_update", status: "running", reasoningDelta: "compare " });
  await coalescer.enqueue({ type: "deep_research_orchestrator_update", status: "running", reasoningDelta: "findings" });
  await wait(20);

  assert.deepEqual(events, [{ type: "deep_research_orchestrator_update", status: "running", reasoningDelta: "compare findings" }]);
  await coalescer.drain();
});

test("flushes text at the size limit and keeps structural events ordered", async () => {
  const events = [];
  const coalescer = createChatEventCoalescer((event) => events.push(event), { flushIntervalMs: 1_000, maxTextLength: 5 });

  await coalescer.enqueue({ type: "content", delta: "hello" });
  await coalescer.enqueue({ type: "content", delta: " world" });
  await coalescer.enqueue({ type: "tool_call", call: { id: "call-1", name: "read", arguments: "{}" } });
  await coalescer.enqueue({ type: "tool_result", result: { id: "call-1", name: "read", ok: true, stdout: "", stderr: "" } });
  await coalescer.drain();

  assert.deepEqual(events.map((event) => event.type), ["content", "content", "tool_call", "tool_result"]);
  assert.equal(events[0].delta, "hello");
  assert.equal(events[1].delta, " world");
});

test("drain flushes the final pending group without waiting for its timer", async () => {
  const events = [];
  const coalescer = createChatEventCoalescer((event) => events.push(event), { flushIntervalMs: 10_000 });

  await coalescer.enqueue({ type: "content", delta: "tail" });
  await coalescer.drain();

  assert.deepEqual(events, [{ type: "content", delta: "tail" }]);
});

test("publishing failures are surfaced and stop later events", async () => {
  const failure = new Error("writer closed");
  const events = [];
  const coalescer = createChatEventCoalescer((event) => {
    events.push(event);
    throw failure;
  }, { flushIntervalMs: 0 });

  await coalescer.enqueue({ type: "content", delta: "first" });
  await assert.rejects(coalescer.drain(), failure);
  await assert.rejects(coalescer.enqueue({ type: "done", usage: null }), failure);
  assert.equal(events.length, 1);
});
