import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseChatRequest } from "../lib/chat-protocol.ts";
import { normalizeOpenRouterModel } from "../app/providers/openrouter/openrouter-catalog-adapter.ts";
import { canonicalCatalogQuery, catalogQueryHash, parseCatalogQuery } from "../app/server/chat/chat-model-catalog-query.ts";
import { normalizeModelPreference, parseChatModelPreference } from "../lib/chat-model-preference.ts";
import { buildOpenRouterMessages } from "../app/providers/openrouter/openrouter-chat-adapter.ts";
import { RESPONSE_STYLE_INSTRUCTIONS } from "../app/server/agent/response-style-instructions.ts";

const eligible = {
  id: "author/model", name: "Model", description: "Useful model", context_length: 131072, created: 1_700_000_000,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"], tokenizer: "Family" },
  supported_parameters: ["tools", "reasoning", "tool_choice"],
  supported_reasoning_efforts: ["low", "medium", "high"],
  pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001", request: "0.01" },
};

test("model references parse structurally and legacy DeepSeek requests remain readable", () => {
  const base = { systemPrompt: "system", userPresence: "", messages: [{ role: "user", content: "Hi" }], thinking: true, reasoningEffort: "medium" };
  assert.deepEqual(parseChatRequest({ ...base, model: { provider: "openrouter", model: "author/model" } }).model, { provider: "openrouter", model: "author/model" });
  assert.deepEqual(parseChatRequest({ ...base, model: "deepseek-v4-flash" }).model, { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.throws(() => parseChatRequest({ ...base, model: { provider: "forged", model: "author/model" } }), /provider\/model reference/);
});

test("OpenRouter normalization enforces text output and tools independently", () => {
  const model = normalizeOpenRouterModel(eligible);
  assert.equal(model?.ref.model, "author/model");
  assert.deepEqual(model?.inputModalities, ["text", "image"]);
  assert.deepEqual(model?.supportedEfforts, ["low", "medium", "high"]);
  assert.equal(model?.pricing?.inputUsdPerMillion, 1);
  assert.equal(normalizeOpenRouterModel({ ...eligible, supported_parameters: ["reasoning"] }), null);
  assert.equal(normalizeOpenRouterModel({ ...eligible, architecture: { ...eligible.architecture, output_modalities: ["image"] } }), null);
});

test("catalog queries lock eligibility, canonicalize and reject unknown values", () => {
  const first = parseCatalogQuery(new URLSearchParams("providers=zeta&providers=alpha&input_modalities=image&sort=top-weekly&zdr=true"));
  const second = parseCatalogQuery(new URLSearchParams("zdr=true&sort=top-weekly&input_modalities=image&providers=alpha&providers=zeta"));
  assert.deepEqual(first.upstream.getAll("output_modalities"), ["text"]);
  assert.ok(first.upstream.getAll("supported_parameters").includes("tools"));
  assert.equal(first.upstream.get("sort"), "most-popular");
  assert.equal(canonicalCatalogQuery(first), canonicalCatalogQuery(second));
  assert.equal(catalogQueryHash(first), catalogQueryHash(second));
  assert.throws(() => parseCatalogQuery(new URLSearchParams("secret=forward-me")), /Unsupported query parameter/);
  assert.throws(() => parseCatalogQuery(new URLSearchParams("sort=random")), /sort is invalid/);
});

test("reasoning fallback respects defaults and mandatory reasoning", () => {
  const metadata = normalizeOpenRouterModel({ ...eligible, reasoning_required: true });
  assert.ok(metadata);
  assert.deepEqual(normalizeModelPreference({ model: metadata.ref, thinking: false, reasoningEffort: "max" }, metadata), {
    model: metadata.ref, thinking: true, reasoningEffort: "medium",
  });
  assert.deepEqual(parseChatModelPreference({ model: "deepseek-v4-flash", thinking: true, reasoningEffort: "high" })?.model, { provider: "deepseek", model: "deepseek-v4-flash" });
});

test("OpenRouter adapter keeps provider wire behavior server-side", async () => {
  const source = await readFile(new URL("../app/providers/openrouter/openrouter-chat-adapter.ts", import.meta.url), "utf8");
  assert.match(source, /reasoning_details/);
  assert.match(source, /tool_call_id/);
  assert.match(source, /data === "\[DONE\]"/);
  assert.match(source, /reader\.cancel/);
  assert.match(source, /metadata\.reasoningRequired/);
  assert.match(source, /supportedParameters\.includes\("tool_choice"\)/);
  assert.doesNotMatch(source, /deepseek/i);
});

test("OpenRouter messages keep response style after tool instructions", () => {
  const messages = buildOpenRouterMessages({
    systemPrompt: "canonical system prompt",
    userPresence: "editable presence",
    model: { provider: "openrouter", model: "author/model" },
    messages: [{ role: "user", content: "Question" }],
    thinking: false,
    reasoningEffort: "high",
  }, {
    replayRounds: [],
    systemInstructions: ["tool instructions", RESPONSE_STYLE_INSTRUCTIONS],
  });

  assert.equal(messages.length, 2);
  const systemContent = messages[0].content;
  assert.equal(typeof systemContent, "string");
  assert.equal(systemContent.indexOf("canonical system prompt"), 0);
  assert.ok(systemContent.indexOf("editable presence") > systemContent.indexOf("canonical system prompt"));
  assert.ok(systemContent.indexOf("tool instructions") > systemContent.indexOf("editable presence"));
  assert.ok(systemContent.indexOf(RESPONSE_STYLE_INSTRUCTIONS) > systemContent.indexOf("tool instructions"));
  assert.equal(systemContent.split(RESPONSE_STYLE_INSTRUCTIONS).length - 1, 1);
});
