import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildIncrementalChatSummaryPrompt,
  buildRebuildChatSummaryPrompt,
  normalizeChatSummary,
} from "../app/server/chat/chat-summary-prompt.ts";
import {
  OPENROUTER_QWEN_FLASH_MODEL,
  summarizeChatWithQwen,
} from "../app/providers/openrouter/openrouter-qwen-text-adapter.ts";
import { OPENROUTER_DEEPSEEK_FLASH_MODEL } from "../app/providers/openrouter/openrouter-config.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("incremental summary prompts contain prior facts and only the visible turn", () => {
  const prompt = buildIncrementalChatSummaryPrompt("User studies calculus.", {
    userContent: "I also play Pokémon Go.",
    assistantContent: "That is useful context.",
  });
  assert.match(prompt, /User studies calculus/);
  assert.match(prompt, /I also play Pokémon Go/);
  assert.match(prompt, /That is useful context/);
  assert.match(prompt, /untrusted data/);
  assert.doesNotMatch(prompt, /reasoning trace/);
});

test("rebuild prompts contain active interactions and branch-discard guidance", () => {
  const prompt = buildRebuildChatSummaryPrompt([
    { userContent: "I study calculus.", assistantContent: "Noted." },
    { userContent: "I collect Charmander.", assistantContent: "That is a durable preference." },
  ]);
  assert.match(prompt, /I study calculus/);
  assert.match(prompt, /I collect Charmander/);
  assert.match(prompt, /Discard facts supported only by obsolete versions/);
});

test("summary output normalization accepts fact lines and handles NONE", () => {
  assert.equal(normalizeChatSummary("```text\n- User studies calculus.\n- User plays Pokémon Go.\n```"), "User studies calculus.\nUser plays Pokémon Go.");
  assert.equal(normalizeChatSummary("NONE"), null);
  assert.equal(normalizeChatSummary(""), null);
});

test("Qwen chat summary adapter sends Flash with reasoning disabled and parses usage", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-summary-key";
  const calls = [];
  try {
    const answer = await summarizeChatWithQwen("summary prompt", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          model: "qwen/test-model",
          choices: [{ message: { content: "User studies calculus." } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(answer.summary, "User studies calculus.");
    assert.equal(answer.model, "qwen/test-model");
    assert.equal(answer.usage?.promptTokens, 20);
    assert.equal(answer.usage?.completionTokens, 5);
    assert.equal(answer.usage?.totalTokens, 25);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.models, [OPENROUTER_QWEN_FLASH_MODEL, OPENROUTER_DEEPSEEK_FLASH_MODEL]);
    assert.equal(body.model, undefined);
    assert.equal(body.messages[0].content, "summary prompt");
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(body.max_tokens, 512);
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("Qwen summary adapter preserves retryable upstream status", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-summary-key";
  try {
    await assert.rejects(
      summarizeChatWithQwen("summary prompt", {
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      }),
      (error) => error.name === "OpenRouterError" && error.status === 429,
    );
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("summary integration remains server-only and is owned by the worker", async () => {
  const [migration, service, route, worker, protocol, history] = await Promise.all([
    source("supabase/migrations/20260728000000_chat_summaries.sql"),
    source("app/server/chat/chat-summary-service.ts"),
    source("app/api/chat/route.ts"),
    source("scripts/background-worker.ts"),
    source("lib/chat-protocol.ts"),
    source("lib/chat-history.ts"),
  ]);
  assert.match(migration, /chat_conversation_summaries/);
  assert.match(migration, /chat_summary_jobs/);
  assert.match(migration, /chat_summary_jobs_one_running/);
  assert.match(migration, /chat_summary/);
  assert.match(service, /processChatSummaryForCompletedJob/);
  assert.match(service, /requestKind: "chat_summary"/);
  assert.doesNotMatch(route, /after\(|processChatSummaryForCompletedJob/);
  assert.match(worker, /processChatSummaryForCompletedJob/);
  assert.doesNotMatch(protocol, /ChatSummary/);
  assert.doesNotMatch(history, /ChatSummary|conversationSummary|durableFacts/);
});
