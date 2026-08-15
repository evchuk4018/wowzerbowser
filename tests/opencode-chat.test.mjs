import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseChatRequest } from "../lib/chat-protocol.ts";
import { applyOpenCodeQuery, fetchOpenCodeModels, normalizeOpenCodeModel } from "../app/providers/opencode/opencode-catalog-adapter.ts";
import { buildOpenCodeMessages, streamOpenCodeChatRound } from "../app/providers/opencode/opencode-chat-adapter.ts";
import { RESPONSE_STYLE_INSTRUCTIONS } from "../app/server/agent/response-style-instructions.ts";

const metadata = {
  ref: { provider: "opencode", model: "deepseek-v4-flash-free" },
  displayName: "DeepSeek V4 Flash Free",
  description: "Free limited-time DeepSeek V4 Flash served through OpenCode Zen.",
  author: "DeepSeek",
  architecture: "DeepSeek V4",
  inputModalities: ["text"],
  outputModalities: ["text"],
  toolSupport: true,
  supportedParameters: ["tools"],
  reasoningRequired: false,
  supportedEfforts: [],
  defaultReasoningEffort: null,
  contextLength: 1_000_000,
  createdAt: null,
  pricing: { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, requestUsd: null, reasoningUsdPerMillion: 0 },
};

const request = {
  systemPrompt: "system",
  userPresence: "present",
  model: { provider: "opencode", model: "deepseek-v4-flash-free" },
  messages: [{ role: "user", content: "Hi" }],
  thinking: false,
  reasoningEffort: "high",
};

test("model references parse structurally for the opencode provider", () => {
  assert.deepEqual(parseChatRequest(request).model, { provider: "opencode", model: "deepseek-v4-flash-free" });
  assert.throws(() => parseChatRequest({ ...request, model: { provider: "forged", model: "deepseek-v4-flash-free" } }), /provider\/model reference/);
});

test("OpenCode catalog normalizes the curated free-tier snapshot and applies local filters", () => {
  const model = normalizeOpenCodeModel("deepseek-v4-flash-free");
  assert.ok(model);
  assert.equal(model.ref.provider, "opencode");
  assert.equal(model.ref.model, "deepseek-v4-flash-free");
  assert.equal(model.pricing?.inputUsdPerMillion, 0);
  assert.equal(model.pricing?.outputUsdPerMillion, 0);
  assert.equal(normalizeOpenCodeModel("gpt-5.6-luna"), null);
  const all = applyOpenCodeQuery(["deepseek-v4-flash-free", "big-pickle", "mimo-v2.5-free"].map(normalizeOpenCodeModel).filter(Boolean), new URLSearchParams());
  assert.equal(all.length, 3);
  const paidOnly = applyOpenCodeQuery(all, new URLSearchParams("min_price=0.000001"));
  assert.equal(paidOnly.length, 0);
  const freeOnly = applyOpenCodeQuery(all, new URLSearchParams("max_price=0"));
  assert.equal(freeOnly.length, 3);
  const search = applyOpenCodeQuery(all, new URLSearchParams("q=big-pickle"));
  assert.deepEqual(search.map((item) => item.ref.model), ["big-pickle"]);
  const providerFilter = applyOpenCodeQuery(all, new URLSearchParams("providers=opencode"));
  assert.equal(providerFilter.length, 3);
  const otherProvider = applyOpenCodeQuery(all, new URLSearchParams("providers=zeta"));
  assert.equal(otherProvider.length, 0);
  const imageOnly = applyOpenCodeQuery(all, new URLSearchParams("input_modalities=image"));
  assert.equal(imageOnly.length, 0);
});

test("OpenCode catalog fetch is keyed on availability and unconfigured keys return an empty set", async () => {
  const originalKey = process.env.OPENCODE_API_KEY;
  const seen = [];
  process.env.OPENCODE_API_KEY = "test-key";
  try {
    const models = await fetchOpenCodeModels(new URLSearchParams(), async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash-free" }, { id: "gpt-5.6-luna" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    assert.ok(String(seen[0]).includes("/zen/v1/models"));
    assert.deepEqual(models.map((item) => item.ref.model), ["deepseek-v4-flash-free"]);
  } finally {
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
  const unconfigured = await fetchOpenCodeModels(new URLSearchParams(), async () => {
    throw new Error("fetch must not be called without a configured key.");
  });
  assert.deepEqual(unconfigured, []);
});

test("OpenCode adapter keeps provider wire behavior server-side", async () => {
  const [source, config] = await Promise.all([
    readFile(new URL("../app/providers/opencode/opencode-chat-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/opencode/opencode-config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(config, /opencode\.ai\/zen\/v1/);
  assert.match(source, /reasoning_details/);
  assert.match(source, /tool_call_id/);
  assert.match(source, /data === "\[DONE\]"/);
  assert.match(source, /reader\.cancel/);
  assert.match(source, /metadata\.reasoningRequired/);
  assert.match(source, /supportedParameters\.includes\("tool_choice"\)/);
  assert.doesNotMatch(source, /api\.deepseek\.com/);
});

test("OpenCode messages keep response style after tool instructions", () => {
  const messages = buildOpenCodeMessages(request, {
    replayRounds: [],
    systemInstructions: ["tool instructions", RESPONSE_STYLE_INSTRUCTIONS],
  });
  assert.equal(messages.length, 2);
  const systemContent = messages[0].content;
  assert.equal(typeof systemContent, "string");
  assert.equal(systemContent.indexOf("system"), 0);
  assert.ok(systemContent.indexOf("present") > systemContent.indexOf("system"));
  assert.ok(systemContent.indexOf("tool instructions") > systemContent.indexOf("present"));
  assert.ok(systemContent.indexOf(RESPONSE_STYLE_INSTRUCTIONS) > systemContent.indexOf("tool instructions"));
  assert.equal(systemContent.split(RESPONSE_STYLE_INSTRUCTIONS).length - 1, 1);
});

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(text) {
  return new Response(new ReadableStream({
    start(controller) {
      const encoded = new TextEncoder().encode(text);
      controller.enqueue(encoded);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("OpenCode streaming emits content, tool calls, usage, and exact cost", async () => {
  const responseText = [
    sseChunk({ model: "deepseek-v4-flash-free", choices: [{ delta: { content: "hello" } }] }),
    sseChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "run_python", arguments: "{\"code\":\"1\"}" } }] } }] }),
    sseChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, cost: 0 } }),
    "data: [DONE]\n\n",
  ].join("");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  let requestBody;
  process.env.OPENCODE_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return streamResponse(responseText);
  };
  try {
    const events = [];
    for await (const event of streamOpenCodeChatRound(request, metadata, { replayRounds: [], systemInstructions: [] }, new AbortController().signal)) events.push(event);
    assert.equal(requestBody.model, "deepseek-v4-flash-free");
    assert.equal(requestBody.stream, true);
    assert.equal("reasoning" in requestBody, false);
    assert.deepEqual(events.map(({ type }) => type), ["content", "reasoning", "done", "tool_call"]);
    assert.equal(events[0].delta, "hello");
    assert.equal(events[1].delta, "thinking");
    assert.equal(events[2].provider, "opencode");
    assert.equal(events[2].model, "deepseek-v4-flash-free");
    assert.equal(events[2].exactCostUsd, 0);
    assert.equal(events[2].pricing?.inputUsdPerMillion, 0);
    assert.equal(events[2].usage?.promptTokens, 10);
    assert.deepEqual(events[3].call, { id: "call-1", name: "run_python", arguments: '{"code":"1"}' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("OpenCode streaming surfaces provider errors and incomplete tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-key";
  try {
    globalThis.fetch = async () => streamResponse(sseChunk({ error: { message: "zen rejected" } }));
    await assert.rejects(async () => {
      for await (const _event of streamOpenCodeChatRound(request, metadata, { replayRounds: [], systemInstructions: [] }, new AbortController().signal)) void _event;
    }, /zen rejected/);
    globalThis.fetch = async () => streamResponse([sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "noop" } }] } }] }), "data: [DONE]\n\n"].join(""));
    await assert.rejects(async () => {
      for await (const _event of streamOpenCodeChatRound(request, metadata, { replayRounds: [], systemInstructions: [] }, new AbortController().signal)) void _event;
    }, /incomplete tool call/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});
