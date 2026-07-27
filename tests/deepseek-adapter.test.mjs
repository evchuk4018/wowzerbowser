import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekDsmlParser, parseDeepSeekDsml } from "../app/providers/deepseek/deepseek-dsml.ts";
import { streamDeepSeekChatRound } from "../app/providers/deepseek/deepseek-adapter.ts";

const request = {
  model: "deepseek-v4-flash",
  systemPrompt: "system",
  userPresence: "present",
  messages: [],
  thinking: false,
  reasoningEffort: "high",
};

function tag(bar, name, closing = false) {
  return `<${closing ? "/" : ""}${bar}DSML${bar}${name}>`;
}

function collect(parser, fragments) {
  let content = "";
  const toolCalls = [];
  let rejected = false;
  for (const fragment of fragments) {
    const result = parser.feed(fragment);
    content += result.content;
    toolCalls.push(...result.toolCalls);
    rejected ||= result.rejected;
  }
  const result = parser.finish();
  return {
    content: content + result.content,
    toolCalls: [...toolCalls, ...result.toolCalls],
    rejected: rejected || result.rejected,
  };
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(text) {
  const encoded = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 3) {
          controller.enqueue(encoded.slice(offset, offset + 3));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("DSML parses fragmented full-width markers, multiple invokes, and typed parameters", () => {
  const bar = "\uFF5C";
  const block = [
    tag(bar, "tool_calls"),
    tag(bar, "invoke").replace(">", ' name="run_python">'),
    tag(bar, "parameter").replace(">", ' name="code" string="true">'),
    "print(1)",
    tag(bar, "parameter", true),
    tag(bar, "parameter").replace(">", ' name="options" string="false">'),
    '{"nested":{"enabled":true},"items":[1,2]}',
    tag(bar, "parameter", true),
    tag(bar, "invoke", true),
    tag(bar, "invoke").replace(">", ' name="noop">'),
    tag(bar, "invoke", true),
    tag(bar, "tool_calls", true),
  ].join("");
  const text = `before ${block} after`;
  const result = collect(new DeepSeekDsmlParser(), [...text].map((character) => character));

  assert.equal(result.content, "before  after");
  assert.equal(result.rejected, false);
  assert.equal(result.toolCalls.length, 2);
  assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
  assert.equal(result.toolCalls[0].name, "run_python");
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
    code: "print(1)",
    options: { nested: { enabled: true }, items: [1, 2] },
  });
  assert.deepEqual(JSON.parse(result.toolCalls[1].arguments), {});
  assert.doesNotMatch(result.content, /DSML|invoke|parameter/);
});

test("DSML accepts ASCII markers and preserves string parameter contents", () => {
  const bar = "|";
  const block = [
    tag(bar, "function_calls"),
    tag(bar, "invoke").replace(">", ' name="echo">'),
    tag(bar, "parameter").replace(">", ' name="value" string="true">'),
    "  raw text with {braces}  ",
    tag(bar, "parameter", true),
    tag(bar, "invoke", true),
    tag(bar, "function_calls", true),
  ].join("");

  const result = parseDeepSeekDsml(`prefix ${block} suffix`);
  assert.equal(result.content, "prefix  suffix");
  assert.equal(result.rejected, false);
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
    value: "  raw text with {braces}  ",
  });
});

test("malformed and truncated DSML blocks are rejected and never become tool calls", () => {
  const bar = "|";
  const malformed = [
    tag(bar, "tool_calls"),
    tag(bar, "invoke").replace(">", ' name="run_python">'),
    tag(bar, "parameter").replace(">", ' name="options" string="false">'),
    "{not-json}",
    tag(bar, "parameter", true),
    tag(bar, "invoke", true),
    tag(bar, "tool_calls", true),
  ].join("");
  const malformedResult = parseDeepSeekDsml(`before ${malformed} after`);
  assert.equal(malformedResult.toolCalls.length, 0);
  assert.equal(malformedResult.rejected, true);
  assert.equal(malformedResult.content, "before  after");

  const truncated = parseDeepSeekDsml(
    `before ${tag(bar, "tool_calls")}${tag(bar, "invoke").replace(">", ' name="run_python">')}`,
  );
  assert.equal(truncated.toolCalls.length, 0);
  assert.equal(truncated.rejected, true);
  assert.equal(truncated.content, "before ");
});

test("adapter suppresses DSML content and deduplicates it against native tool_calls", async () => {
  const bar = "\uFF5C";
  const dsml = [
    tag(bar, "tool_calls"),
    tag(bar, "invoke").replace(">", ' name="run_python">'),
    tag(bar, "parameter").replace(">", ' name="code" string="true">'),
    "print(1)",
    tag(bar, "parameter", true),
    tag(bar, "invoke", true),
    tag(bar, "tool_calls", true),
  ].join("");
  const responseText = [
    sseChunk({ choices: [{ delta: { content: `answer ${dsml.slice(0, 12)}` } }] }),
    sseChunk({ choices: [{ delta: { content: dsml.slice(12) } }] }),
    sseChunk({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "native-1",
            function: { name: "run_python", arguments: '{"code":"print(1)"}' },
          }],
        },
      }],
    }),
    "data: [DONE]\n\n",
  ].join("");

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => streamResponse(responseText);
  try {
    const events = [];
    for await (const event of streamDeepSeekChatRound(request, {
      tools: [{
        type: "function",
        function: { name: "run_python", description: "Run Python", parameters: { type: "object" } },
      }],
    })) events.push(event);

    assert.deepEqual(events.filter(({ type }) => type === "content"), [
      { type: "content", delta: "answer " },
    ]);
    const calls = events.filter(({ type }) => type === "tool_call").map(({ call }) => call);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      id: "native-1",
      name: "run_python",
      arguments: '{"code":"print(1)"}',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
});

test("adapter preserves DSML-looking ordinary text when no tools are advertised", async () => {
  const text = "literal <|DSML|tool_calls> example";
  const responseText = `${sseChunk({ choices: [{ delta: { reasoning_content: text, content: text } }] })}data: [DONE]\n\n`;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => streamResponse(responseText);
  try {
    const events = [];
    for await (const event of streamDeepSeekChatRound(request)) events.push(event);
    assert.deepEqual(events.filter(({ type }) => type === "reasoning"), [{ type: "reasoning", delta: text }]);
    assert.deepEqual(events.filter(({ type }) => type === "content"), [{ type: "content", delta: text }]);
    assert.equal(events.filter(({ type }) => type === "tool_call").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
});

test("adapter parses DSML from reasoning_content while preserving visible reasoning", async () => {
  const bar = "\uFF5C";
  const dsml = [
    tag(bar, "tool_calls"),
    tag(bar, "invoke").replace(">", ' name="noop">'),
    tag(bar, "invoke", true),
    tag(bar, "tool_calls", true),
  ].join("");
  const responseText = [
    sseChunk({ choices: [{ delta: { reasoning_content: `thinking ${dsml.slice(0, 10)}` } }] }),
    sseChunk({ choices: [{ delta: { reasoning_content: `${dsml.slice(10)} still thinking` } }] }),
    "data: [DONE]\n\n",
  ].join("");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => streamResponse(responseText);
  try {
    const events = [];
    for await (const event of streamDeepSeekChatRound(request, {
      tools: [{
        type: "function",
        function: { name: "noop", description: "Do nothing", parameters: { type: "object" } },
      }],
    })) events.push(event);
    assert.deepEqual(events.filter(({ type }) => type === "reasoning"), [
      { type: "reasoning", delta: "thinking " },
      { type: "reasoning", delta: " still thinking" },
    ]);
    const calls = events.filter(({ type }) => type === "tool_call").map(({ call }) => call);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "noop");
    assert.deepEqual(JSON.parse(calls[0].arguments), {});
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
});

test("adapter fails the stream for malformed or truncated DSML when tools are advertised", async () => {
  const bar = "|";
  const truncated = `${sseChunk({ choices: [{ delta: { content: `before ${tag(bar, "tool_calls")}` } }] })}data: [DONE]\n\n`;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => streamResponse(truncated);
  try {
    await assert.rejects(
      (async () => {
        for await (const event of streamDeepSeekChatRound(request, {
          tools: [{
            type: "function",
            function: { name: "run_python", description: "Run Python", parameters: { type: "object" } },
          }],
        })) void event;
      })(),
      /malformed or truncated DSML/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
});
