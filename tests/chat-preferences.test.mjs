import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeChatModelInfo,
  normalizeChatModels,
} from "../app/chat/use-chat-preferences.ts";

test("normalizes model capabilities and drops unknown model ids", () => {
  assert.deepEqual(normalizeChatModelInfo({
    id: "deepseek-v4-flash",
    label: " Flash ",
    thinkingSupported: true,
    supportedEfforts: ["high", "high", "invalid"],
  }), {
    id: "deepseek-v4-flash",
    label: " Flash ",
    thinkingSupported: true,
    supportedEfforts: ["high"],
  });
  assert.equal(normalizeChatModelInfo({ id: "unknown", label: "Nope" }), null);
});

test("uses built-in capabilities when remote model data is empty or malformed", () => {
  const defaults = normalizeChatModels([]);
  assert.deepEqual(defaults.map(({ id }) => id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(normalizeChatModels([{ id: "unknown" }]).map(({ id }) => id), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
});

