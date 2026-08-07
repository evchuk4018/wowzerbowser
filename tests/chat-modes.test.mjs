import test from "node:test";
import assert from "node:assert/strict";
import { chatModeCommandAtCaret, clearChatModeCommand, parseChatModeCommand } from "../lib/chat-modes.ts";
import { filterChatComposerCommands, moveChatCommandIndex, removeChatCommandToken } from "../lib/chat-command-picker.ts";
import { runSubagents } from "../app/server/agent/subagent-coordinator.ts";

test("deep research slash command is extracted from the prompt", () => {
  assert.deepEqual(parseChatModeCommand("/deep-research compare battery technologies"), {
    mode: "deep_research",
    content: "compare battery technologies",
  });
  assert.deepEqual(parseChatModeCommand("ordinary question"), { mode: "normal", content: "ordinary question" });
});

test("deep research slash command is extracted from anywhere in a prompt", () => {
  assert.deepEqual(parseChatModeCommand("compare /deep-research battery technologies"), {
    mode: "deep_research",
    content: "compare battery technologies",
  });
  assert.deepEqual(parseChatModeCommand("CHECK /DEEP-RESEARCH this"), {
    mode: "deep_research",
    content: "CHECK this",
  });
  assert.deepEqual(parseChatModeCommand("https://example.test/deep-research is a URL"), {
    mode: "normal",
    content: "https://example.test/deep-research is a URL",
  });
});

test("deep research mode can be cleared without changing URL text", () => {
  assert.equal(clearChatModeCommand("/deep-research compare battery technologies"), "compare battery technologies");
  assert.equal(clearChatModeCommand("compare /deep-research battery technologies"), "compare battery technologies");
  assert.equal(clearChatModeCommand("https://example.test/deep-research is a URL"), "https://example.test/deep-research is a URL");
});

test("command autocomplete finds a standalone slash token at the caret", () => {
  assert.deepEqual(chatModeCommandAtCaret("compare /deep", 13), { start: 8, end: 13, query: "/deep" });
  assert.deepEqual(chatModeCommandAtCaret("compare /deep battery", 13), { start: 8, end: 13, query: "/deep" });
  assert.equal(chatModeCommandAtCaret("compare/deep", 12), null);
});

test("project autocomplete filters by the slash token and removes only that token", () => {
  assert.deepEqual(filterChatComposerCommands("/pro").map(({ command }) => command), ["/projects"]);
  assert.deepEqual(filterChatComposerCommands("/").map(({ command }) => command), ["/deep-research", "/projects"]);
  const draft = "Keep this /projects beside the rest";
  assert.equal(removeChatCommandToken(draft, { start: 10, end: 19 }), "Keep this  beside the rest");
});

test("project autocomplete index wraps in both directions", () => {
  assert.equal(moveChatCommandIndex(0, -1, 3), 2);
  assert.equal(moveChatCommandIndex(2, 1, 3), 0);
  assert.equal(moveChatCommandIndex(0, 1, 0), 0);
});

test("subagent coordinator runs bounded work and preserves task order", async () => {
  const active = { value: 0, maximum: 0 };
  const result = await runSubagents({
    tasks: [1, 2, 3, 4].map((id) => ({ id: String(id), title: `Task ${id}`, prompt: String(id) })),
    concurrency: 2,
    worker: async (task) => {
      active.value += 1;
      active.maximum = Math.max(active.maximum, active.value);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.value -= 1;
      return task.id;
    },
  });
  assert.equal(active.maximum, 2);
  assert.deepEqual(result.map((item) => item.value), ["1", "2", "3", "4"]);
});
