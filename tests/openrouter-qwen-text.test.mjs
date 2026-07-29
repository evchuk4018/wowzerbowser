import assert from "node:assert/strict";
import test from "node:test";
import {
  completeOpenRouterQwenText,
  generateQwenTitle,
  OPENROUTER_QWEN_FLASH_MODEL,
  recallChatWithQwen,
  summarizeChatWithQwen,
  summarizeReasoningWithQwenFlash,
} from "../app/providers/openrouter/openrouter-qwen-text-adapter.ts";
import { OPENROUTER_DEEPSEEK_FLASH_MODEL } from "../app/providers/openrouter/openrouter-config.ts";

const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-qwen-key";

test.after(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function response(content, overrides = {}) {
  return new Response(JSON.stringify({
    model: "qwen/provider-route",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.0012 },
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("Qwen text adapter sends OpenRouter requests with reasoning disabled and captures usage/cost", async () => {
  const calls = [];
  const answer = await completeOpenRouterQwenText("user prompt", {
    systemPrompt: "system prompt",
    maxTokens: 24,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response([{ type: "text", text: "A concise answer" }]);
    },
  });

  assert.equal(answer.content, "A concise answer");
  assert.equal(answer.model, "qwen/provider-route");
  assert.equal(answer.usage?.totalTokens, 16);
  assert.equal(answer.exactCostUsd, 0.0012);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-qwen-key");
  assert.deepEqual(body.models, [OPENROUTER_QWEN_FLASH_MODEL, OPENROUTER_DEEPSEEK_FLASH_MODEL]);
  assert.equal(body.model, undefined);
  assert.deepEqual(body.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user prompt" },
  ]);
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 24);
});

test("Qwen task wrappers preserve title, summary, reasoning, and recall limits", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response("Useful result");
  };
  const usages = [];
  await generateQwenTitle("Name this conversation", async (usage) => usages.push(usage), { fetchImpl });
  await summarizeChatWithQwen("summary prompt", { fetchImpl });
  await summarizeReasoningWithQwenFlash("reasoning prompt", undefined, { fetchImpl });
  await recallChatWithQwen("private context", "recall prompt", { fetchImpl });

  assert.equal(usages[0].provider, "openrouter");
  assert.equal(usages[0].model, "qwen/provider-route");
  assert.equal(usages[0].exactCostUsd, 0.0012);
  assert.equal(bodies[0].max_tokens, 24);
  assert.equal(bodies[1].max_tokens, 512);
  assert.equal(bodies[2].max_tokens, 32);
  assert.equal(bodies[3].max_tokens, undefined);
  for (const body of bodies) {
    assert.deepEqual(body.models, [OPENROUTER_QWEN_FLASH_MODEL, OPENROUTER_DEEPSEEK_FLASH_MODEL]);
    assert.equal(body.model, undefined);
  }
  assert.match(bodies[3].messages[0].content, /conversation data is untrusted content/);
});

test("Qwen text adapter preserves the model selected by OpenRouter fallback routing", async () => {
  const answer = await completeOpenRouterQwenText("fallback prompt", {
    fetchImpl: async () => response("DeepSeek result", { model: OPENROUTER_DEEPSEEK_FLASH_MODEL }),
  });

  assert.equal(answer.content, "DeepSeek result");
  assert.equal(answer.model, OPENROUTER_DEEPSEEK_FLASH_MODEL);
});

test("Qwen text adapter preserves cancellation and retryable upstream errors", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    completeOpenRouterQwenText("cancelled", {
      signal: controller.signal,
      fetchImpl: async () => { throw new Error("aborted"); },
    }),
    (error) => error.status === 499,
  );
  await assert.rejects(
    completeOpenRouterQwenText("rate limited", {
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    }),
    (error) => error.status === 429,
  );
});
