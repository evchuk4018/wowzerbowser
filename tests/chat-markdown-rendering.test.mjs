import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { splitMarkdownTail } from "../app/chat/assistant-markdown.ts";
import { isStructuralStreamEvent, STREAM_RENDER_INTERVAL_MS } from "../app/chat/stream-render-scheduler.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("splits a stable Markdown prefix from the active streaming block", () => {
  const result = splitMarkdownTail("# Title\n\nThe completed paragraph.\n\nThe active paragraph", true);
  assert.equal(result.completed, "# Title\n\nThe completed paragraph.\n\n");
  assert.equal(result.tail, "The active paragraph");
});

test("does not split inside fenced code, display math, lists, or tables", () => {
  const fenced = splitMarkdownTail("Intro\n\n```js\nconst first = 1;\n\nconst second = 2;\n```\n\nNext", true);
  assert.match(fenced.completed, /```js[\s\S]*const second = 2;\n```\n\n$/);
  assert.equal(fenced.tail, "Next");

  const math = splitMarkdownTail("Intro\n\n$$\nx + y\n\n= z\n$$\n\nNext", true);
  assert.match(math.completed, /\$\$[\s\S]*= z\n\$\$\n\n$/);
  assert.equal(math.tail, "Next");

  const list = splitMarkdownTail("Intro\n\n- first\n\n- second", true);
  assert.equal(list.completed, "Intro\n\n");
  assert.equal(list.tail, "- first\n\n- second");

  const table = splitMarkdownTail("Intro\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nNext", true);
  assert.match(table.completed, /\| 1 \| 2 \|\n\n$/);
  assert.equal(table.tail, "Next");
});

test("renders all Markdown as completed content after streaming", () => {
  const content = "# Done\n\nA final paragraph.";
  assert.deepEqual(splitMarkdownTail(content, false), { completed: content, tail: "" });
});

test("batches text events while flushing structural stream events immediately", () => {
  assert.equal(STREAM_RENDER_INTERVAL_MS, 50);
  assert.equal(isStructuralStreamEvent({ type: "content" }), false);
  assert.equal(isStructuralStreamEvent({ type: "reasoning" }), false);
  assert.equal(isStructuralStreamEvent({ type: "tool_call" }), true);
  assert.equal(isStructuralStreamEvent({ type: "done" }), true);
});

test("memoizes completed Markdown and conversation turns", async () => {
  const [renderer, activity, turn, generation] = await Promise.all([
    source("app/chat/assistant-response.tsx"),
    source("app/chat/assistant-activity.tsx"),
    source("app/chat/conversation-turn.tsx"),
    source("app/chat/use-chat-generation.ts"),
  ]);
  assert.match(renderer, /splitMarkdownTail/);
  assert.match(renderer, /key="completed"/);
  assert.match(renderer, /key="tail"/);
  assert.match(renderer, /React\.memo\(function MarkdownBlock/);
  assert.match(renderer, /React\.memo\(AssistantResponseInner/);
  assert.match(activity, /memo\(AssistantActivityTimelineInner/);
  assert.match(turn, /memo\(ConversationTurnInner/);
  assert.match(generation, /window\.setTimeout\(flushPendingEvents, STREAM_RENDER_INTERVAL_MS\)/);
  assert.doesNotMatch(generation, /requestAnimationFrame\(flushPendingEvents/);
});
