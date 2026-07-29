import assert from "node:assert/strict";
import test from "node:test";
import {
  detectChatImageContentType,
  validateChatImageBytes,
} from "../lib/chat-image.ts";
import {
  analyzeOpenRouterImage,
  askOpenRouterAboutImage,
  OPENROUTER_IMAGE_MODEL,
} from "../app/providers/openrouter/openrouter-image-adapter.ts";
import {
  OPENROUTER_AUTO_MODEL,
  OPENROUTER_GEMINI_FLASH_LITE_MODEL,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_NEX_N2_MINI_MODEL,
} from "../app/providers/openrouter/openrouter-config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0, 0, 0, 0, 0,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

test("server validation checks decoded image signatures and MIME consistency", () => {
  assert.equal(detectChatImageContentType(png), "image/png");
  assert.equal(validateChatImageBytes(png, "image/png"), "image/png");
  assert.throws(() => validateChatImageBytes(png, "image/jpeg"), /does not match/);
  assert.throws(() => validateChatImageBytes(new Uint8Array([1, 2, 3]), "image/png"), /supported/);
});

test("OpenRouter image transport sends the prompt before the image and returns actual model and usage", async () => {
  const calls = [];
  const answer = await askOpenRouterAboutImage("What text is visible?", png, "image/png", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        model: "provider/free-vision",
        choices: [{ message: { content: "Hello" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(answer.content, "Hello");
  assert.equal(answer.model, "provider/free-vision");
  assert.equal(answer.usage?.promptTokens, 12);
  assert.equal(answer.usage?.completionTokens, 3);
  assert.equal(answer.usage?.totalTokens, 15);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(OPENROUTER_IMAGE_MODEL, OPENROUTER_AUTO_MODEL);
  assert.deepEqual(body.models, [
    OPENROUTER_AUTO_MODEL,
    OPENROUTER_NEX_N2_MINI_MODEL,
    OPENROUTER_GEMINI_FLASH_LITE_MODEL,
  ]);
  assert.equal(body.models.length, 3);
  assert.deepEqual(body.models, [...OPENROUTER_IMAGE_MODELS]);
  assert.equal(body.model, undefined);
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("OpenRouter rate limits and empty answers become controlled errors", async () => {
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => new Response("upstream secret", { status: 429 }),
      retryDelayMs: 0,
    }),
    /temporarily rate limited/,
  );
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    }),
    /empty answer/,
  );
});

test("OpenRouter sends the ordered model fallback chain in one request", async () => {
  const calls = [];
  const answer = await askOpenRouterAboutImage("Question", png, "image/png", {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return new Response(JSON.stringify({
        model: OPENROUTER_GEMINI_FLASH_LITE_MODEL,
        choices: [{ message: { content: "Fallback answer" } }],
      }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].models, [...OPENROUTER_IMAGE_MODELS]);
  assert.equal(answer.model, OPENROUTER_GEMINI_FLASH_LITE_MODEL);
});

test("OpenRouter image validation failures do not retry another model", async () => {
  let calls = 0;
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("invalid request", { status: 400 });
      },
    }),
    /No configured image understanding model/,
  );
  assert.equal(calls, 1);
});

test("combined image analysis requests structured output and parses one response", async () => {
  const calls = [];
  const answer = await analyzeOpenRouterImage("Analyze once", png, "image/png", {
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        model: OPENROUTER_NEX_N2_MINI_MODEL,
        choices: [{ message: { content: JSON.stringify({
          visibleText: "Hello",
          mainVisuals: "A sign.",
        }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response_format.type, "json_schema");
  assert.equal(calls[0].provider.require_parameters, true);
  assert.deepEqual(answer, {
    visibleText: "Hello",
    mainVisuals: "A sign.",
    model: OPENROUTER_NEX_N2_MINI_MODEL,
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28, cachedPromptTokens: undefined, reasoningTokens: undefined },
  });
});

test("combined image analysis normalizes NONE and rejects malformed structured output", async () => {
  const normalized = await analyzeOpenRouterImage("Analyze once", png, "image/png", {
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"visibleText":"NONE","mainVisuals":"A blank page."}' } }],
    }), { status: 200 }),
  });
  assert.equal(normalized.visibleText, null);
  await assert.rejects(
    analyzeOpenRouterImage("Analyze once", png, "image/png", {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"visibleText":null}' } }],
      }), { status: 200 }),
    }),
    /invalid response/,
  );
});

test("OpenRouter retries one 429 using Retry-After and preserves one deadline", async () => {
  let calls = 0;
  const answer = await askOpenRouterAboutImage("Question", png, "image/png", {
    retryDelayMs: 10_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        error: { code: 429, metadata: { error_type: "rate_limit_exceeded" } },
      }), { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Recovered" } }],
      }), { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(answer.content, "Recovered");
});

test("OpenRouter does not retry permanent credit errors", async () => {
  let calls = 0;
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: { code: 402, metadata: { error_type: "payment_required" } },
        }), { status: 402 });
      },
    }),
    (error) => error.code === "credits_exhausted" && /credits are exhausted/.test(error.message),
  );
  assert.equal(calls, 1);
});

test("OpenRouter skips a retry that cannot fit within the request deadline", async () => {
  let calls = 0;
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      timeoutMs: 100,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: { code: 429, metadata: { error_type: "rate_limit_exceeded" } },
        }), { status: 429, headers: { "retry-after": "60" } });
      },
    }),
    (error) => error.code === "rate_limit",
  );
  assert.equal(calls, 1);
});

test("OpenRouter cancellation interrupts retry backoff", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = askOpenRouterAboutImage("Question", png, "image/png", {
    signal: controller.signal,
    retryDelayMs: 10_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    },
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error) => error.code === "cancelled" && error.status === 499);
  assert.equal(calls, 1);
});
