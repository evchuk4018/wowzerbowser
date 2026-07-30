import assert from "node:assert/strict";
import test from "node:test";
import { readChatLiveStream } from "../app/chat/read-chat-live-stream.ts";
import { streamChatResponse } from "../app/chat/chat-service.ts";

const encoder = new TextEncoder();

test("reads fragmented SSE frames in order", async () => {
  const frames = [
    { type: "submission", submission: { jobId: "job-1", status: "queued", resumed: false } },
    { type: "event", event: { type: "content", delta: "fast", sequence: 1, jobId: "job-1" } },
    {
      type: "terminal",
      terminal: {
        jobId: "job-1",
        status: "completed",
        error: null,
        usage: { completionTokens: 1 },
        finalOutput: "fast",
      },
    },
  ];
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0, 19)));
      controller.enqueue(encoder.encode(payload.slice(19, 71)));
      controller.enqueue(encoder.encode(payload.slice(71)));
      controller.close();
    },
  }));

  const received = [];
  for await (const frame of readChatLiveStream(response)) received.push(frame);
  assert.deepEqual(received, frames);
});

test("ignores malformed SSE frames without dropping later events", async () => {
  const valid = { type: "event", event: { type: "content", delta: "ok", sequence: 1, jobId: "job-1" } };
  const response = new Response(`data: not-json\n\ndata: ${JSON.stringify(valid)}\n\n`);
  const received = [];
  for await (const frame of readChatLiveStream(response)) received.push(frame);
  assert.deepEqual(received, [valid]);
});

test("paginates durable replay before honoring a terminal status", async () => {
  const originalFetch = globalThis.fetch;
  const snapshots = [
    {
      jobId: "job-1",
      conversationId: "conversation-1",
      status: "completed",
      events: [{ type: "content", delta: "page one", sequence: 1, jobId: "job-1" }],
      hasMore: true,
      lastSequence: 1,
      error: null,
      usage: null,
      finalOutput: "page one page two",
      createdAt: "",
      updatedAt: "",
    },
    {
      jobId: "job-1",
      conversationId: "conversation-1",
      status: "completed",
      events: [{ type: "content", delta: " page two", sequence: 2, jobId: "job-1" }],
      hasMore: false,
      lastSequence: 2,
      error: null,
      usage: null,
      finalOutput: "page one page two",
      createdAt: "",
      updatedAt: "",
    },
  ];
  let poll = 0;
  let resumeCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/chat") {
      return new Response(`data: ${JSON.stringify({
        type: "submission",
        submission: { jobId: "job-1", status: "completed", resumed: true },
      })}\n\n`, { status: 200 });
    }
    if (url.endsWith("/resume")) {
      resumeCalls += 1;
      return Response.json({ accepted: true }, { status: 202 });
    }
    return Response.json(snapshots[poll++]);
  };

  try {
    const received = [];
    for await (const event of streamChatResponse({
      conversationId: "conversation-1",
      jobId: "job-1",
    }, "token")) {
      received.push(event);
    }
    assert.deepEqual(
      received.filter(({ type }) => type === "content").map(({ delta }) => delta),
      ["page one", " page two"],
    );
    assert.equal(received.at(-1).type, "done");
    assert.equal(poll, 2);
    assert.equal(resumeCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes a failed durable fallback with no persisted error event", async () => {
  const originalFetch = globalThis.fetch;
  let poll = 0;
  let resumeCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/chat") {
      return new Response(`data: ${JSON.stringify({
        type: "submission",
        submission: { jobId: "job-1", status: "running", resumed: true },
      })}\n\n`, { status: 200 });
    }
    if (url.endsWith("/resume")) {
      resumeCalls += 1;
      return Response.json({ accepted: true }, { status: 202 });
    }
    poll += 1;
    return Response.json({
      jobId: "job-1",
      conversationId: "conversation-1",
      status: "failed",
      events: [],
      hasMore: false,
      lastSequence: 0,
      error: "database failed",
      usage: null,
      finalOutput: "",
      createdAt: "",
      updatedAt: "",
    });
  };

  try {
    const received = [];
    for await (const event of streamChatResponse({
      conversationId: "conversation-1",
      jobId: "job-1",
    }, "token")) {
      received.push(event);
    }
    assert.deepEqual(received.map(({ type }) => type), ["error", "done"]);
    assert.equal(received[0].message, "database failed");
    assert.equal(poll, 1);
    assert.equal(resumeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes a cancelled live terminal frame", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({
      type: "submission",
      submission: { jobId: "job-1", status: "queued", resumed: false },
    })}`,
    `data: ${JSON.stringify({
      type: "terminal",
      terminal: {
        jobId: "job-1",
        status: "cancelled",
        error: null,
        usage: null,
        finalOutput: "",
      },
    })}`,
    "",
  ].join("\n\n"), { status: 202 });

  try {
    const received = [];
    for await (const event of streamChatResponse({
      conversationId: "conversation-1",
      jobId: "job-1",
    }, "token")) {
      received.push(event);
    }
    assert.deepEqual(received.map(({ type }) => type), ["cancelled"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
