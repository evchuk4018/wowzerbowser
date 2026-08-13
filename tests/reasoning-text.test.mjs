import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyChatStreamEvent } from "../lib/chat-history.ts";
import { normalizeReasoningText } from "../app/chat/normalize-reasoning-text.ts";

test("joins fragmented Qwen-style prose and collapses excessive line breaks", () => {
  assert.equal(
    normalizeReasoningText("I need to\ninspect the evidence.\nThen I can\nanswer.\n\n\n\nThe result is clear.\n"),
    "I need to inspect the evidence. Then I can answer.\n\nThe result is clear.",
  );
});

test("preserves intentional blank-line paragraphs", () => {
  assert.equal(
    normalizeReasoningText("First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph."),
    "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  );
});

test("repairs fragmented numbered markers and preserves readable lists", () => {
  assert.equal(
    normalizeReasoningText("Steps:\n1\n. Check the input\n2\n. Review the output\n\n- Keep the list\n- Keep this item too."),
    "Steps:\n1. Check the input\n2. Review the output\n\n- Keep the list\n- Keep this item too.",
  );
});

test("keeps raw streamed reasoning unchanged while normalizing its display value", async () => {
  const raw = "I need to\ncheck this.\n\n\n1\n. Continue.";
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    reasoning: "",
    activities: [],
    status: "streaming",
  };
  const next = applyChatStreamEvent(message, { type: "reasoning", delta: raw }, 1);

  assert.equal(next.reasoning, raw);
  assert.equal(next.activities?.[0]?.content, raw);
  assert.equal(normalizeReasoningText(next.reasoning), "I need to check this.\n\n1. Continue.");

  const [activity, response] = await Promise.all([
    readFile(new URL("../app/chat/assistant-activity.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/assistant-response.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(activity, /normalizeReasoningText\(item\.content\)/);
  assert.doesNotMatch(response, /normalizeReasoningText/);
});
