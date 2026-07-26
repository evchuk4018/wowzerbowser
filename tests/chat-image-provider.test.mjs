import assert from "node:assert/strict";
import test from "node:test";
import {
  detectChatImageContentType,
  validateChatImageBytes,
} from "../lib/chat-image.ts";
import {
  askOpenRouterAboutImage,
  OPENROUTER_IMAGE_MODEL,
} from "../app/providers/openrouter/openrouter-image-adapter.ts";

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
  assert.equal(body.model, OPENROUTER_IMAGE_MODEL);
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("OpenRouter rate limits and empty answers become controlled errors", async () => {
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => new Response("upstream secret", { status: 429 }),
    }),
    /rate limited/,
  );
  await assert.rejects(
    askOpenRouterAboutImage("Question", png, "image/png", {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    }),
    /empty answer/,
  );
});
