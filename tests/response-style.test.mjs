import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CHAT_SYSTEM_PROMPT, parseChatRequest } from "../lib/chat-protocol.ts";
import {
  DEFAULT_CHAT_MODEL_PREFERENCE,
  normalizeModelPreference,
  parseChatModelPreference,
} from "../lib/chat-model-preference.ts";
import { RESPONSE_STYLE_INSTRUCTIONS } from "../app/server/agent/response-style-instructions.ts";

test("response style instructions encode the concise default behavior", () => {
  for (const rule of [
    "Answer the user's actual question immediately.",
    "Do not restate the user's question",
    "Do not begin with filler",
    "Do not end by asking whether the user wants more",
    "Use the minimum formatting needed for readability",
    "Preserve exact fractions unless a decimal is requested or required",
    "Match the response size to the task",
    "Treat requests such as \"concise,\" \"simple,\" \"to the point,\" \"just answer,\"",
  ]) {
    assert.match(RESPONSE_STYLE_INSTRUCTIONS, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(RESPONSE_STYLE_INSTRUCTIONS, /Before sending, remove every sentence/);
  assert.match(RESPONSE_STYLE_INSTRUCTIONS, /Want me to explain further\?/);
});

test("response-style evaluation examples map to proportional response rules", () => {
  const evaluations = [
    {
      prompt: "What is Temple CIP code and title for mechanical engineering?",
      rules: ["Direct factual question: answer in 1 to 4 lines", "side facts, related topics"],
    },
    {
      prompt: "Give me a worked example of planar motion with integrals. Keep it simple and to the point. Show displacement.",
      rules: ["Worked example: choose the simplest example", "additional stages, or unrelated calculations", "hard constraints"],
    },
    {
      prompt: "I got 12.5. Is that correct?",
      rules: ["Preserve exact fractions", "Do not show both exact and decimal forms", "Do not repeat the boxed answer"],
    },
    {
      prompt: "Why is 20 not the final x value?",
      rules: ["When correcting the user, state the exact mistake first"],
    },
    {
      prompt: "Qwen 3.7 Flash vs DeepSeek V4 Flash",
      rules: ["Comparison: use a compact table", "no more than a brief conclusion"],
    },
  ];

  for (const evaluation of evaluations) {
    assert.ok(evaluation.prompt.length > 0);
    for (const rule of evaluation.rules) assert.ok(RESPONSE_STYLE_INSTRUCTIONS.includes(rule), `${evaluation.prompt}: missing ${rule}`);
  }
});

test("canonical prompt contains operational response behavior and stays user-independent", () => {
  assert.match(DEFAULT_CHAT_SYSTEM_PROMPT, /shortest response that completely satisfies the request/);
  assert.match(DEFAULT_CHAT_SYSTEM_PROMPT, /does not restate the question/);
  assert.match(DEFAULT_CHAT_SYSTEM_PROMPT, /does not add generic follow-up questions/);
  assert.doesNotMatch(DEFAULT_CHAT_SYSTEM_PROMPT, /User supplied prompt/);

  const parsed = parseChatRequest({
    systemPrompt: "User supplied prompt",
    userPresence: "editable presence",
    model: "deepseek-v4-flash",
    thinking: false,
    reasoningEffort: "high",
    messages: [{ role: "user", content: "Question" }],
  });
  assert.equal(parsed.systemPrompt, DEFAULT_CHAT_SYSTEM_PROMPT);
  assert.equal(parsed.userPresence, "editable presence");
});

test("system instruction assembly imports response style last after tool instructions", async () => {
  const service = await readFile(new URL("../app/chat/chat-server-service.ts", import.meta.url), "utf8");
  assert.match(service, /import \{ RESPONSE_STYLE_INSTRUCTIONS \} from "\.\.\/server\/agent\/response-style-instructions"/);
  assert.match(service, /USER_MEMORY_TOOL_INSTRUCTIONS,\s*RESPONSE_STYLE_INSTRUCTIONS,/);
  assert.equal((service.match(/RESPONSE_STYLE_INSTRUCTIONS/g) ?? []).length, 2);
});

test("new model preferences disable thinking while saved and required reasoning remain supported", () => {
  assert.equal(DEFAULT_CHAT_MODEL_PREFERENCE.thinking, false);
  assert.equal(parseChatModelPreference({
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "high",
  })?.thinking, true);

  const metadata = {
    ref: { provider: "openrouter", model: "author/model" },
    supportedEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    reasoningRequired: false,
  };
  assert.equal(normalizeModelPreference({ ...DEFAULT_CHAT_MODEL_PREFERENCE, model: metadata.ref }, metadata).thinking, false);
  assert.equal(normalizeModelPreference({ ...DEFAULT_CHAT_MODEL_PREFERENCE, model: metadata.ref, thinking: true }, metadata).thinking, true);
  assert.equal(normalizeModelPreference({ ...DEFAULT_CHAT_MODEL_PREFERENCE, model: metadata.ref }, { ...metadata, reasoningRequired: true }).thinking, true);
});
