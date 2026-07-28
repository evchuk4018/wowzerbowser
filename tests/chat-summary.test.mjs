import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildIncrementalChatSummaryPrompt,
  buildRebuildChatSummaryPrompt,
  normalizeChatSummary,
} from "../app/server/chat/chat-summary-prompt.ts";
import {
  OPENROUTER_CHAT_SUMMARY_MODEL,
  OpenRouterChatSummaryError,
  summarizeChatWithOpenRouter,
} from "../app/providers/openrouter/openrouter-chat-summary-adapter.ts";

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

test("OpenRouter chat summary adapter sends the free model and parses usage", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-summary-key";
  const calls = [];
  try {
    const answer = await summarizeChatWithOpenRouter("summary prompt", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          model: "free/test-model",
          choices: [{ message: { content: "User studies calculus." } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(answer.summary, "User studies calculus.");
    assert.equal(answer.model, "free/test-model");
    assert.equal(answer.usage?.promptTokens, 20);
    assert.equal(answer.usage?.completionTokens, 5);
    assert.equal(answer.usage?.totalTokens, 25);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, OPENROUTER_CHAT_SUMMARY_MODEL);
    assert.equal(body.messages[0].content, "summary prompt");
    assert.equal(body.max_tokens, 512);
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("OpenRouter summary adapter classifies rate limits as retryable", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-summary-key";
  try {
    await assert.rejects(
      summarizeChatWithOpenRouter("summary prompt", {
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      }),
      (error) => error instanceof OpenRouterChatSummaryError
        && error.code === "rate_limit"
        && error.retryable === true,
    );
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("summary integration remains server-only and hidden from chat protocol surfaces", async () => {
  const [migration, service, route, protocol, history] = await Promise.all([
    source("supabase/migrations/20260728000000_chat_summaries.sql"),
    source("app/server/chat/chat-summary-service.ts"),
    source("app/api/chat/route.ts"),
    source("lib/chat-protocol.ts"),
    source("lib/chat-history.ts"),
  ]);
  assert.match(migration, /chat_conversation_summaries/);
  assert.match(migration, /chat_summary_jobs/);
  assert.match(migration, /chat_summary_jobs_one_running/);
  assert.match(migration, /chat_summary/);
  assert.match(service, /processChatSummaryForCompletedJob/);
  assert.match(service, /requestKind: "chat_summary"/);
  assert.match(route, /after\(\(\) => completion\)/);
  assert.match(route, /processChatSummaryForCompletedJob/);
  assert.doesNotMatch(protocol, /ChatSummary/);
  assert.doesNotMatch(history, /ChatSummary|conversationSummary|durableFacts/);
});
