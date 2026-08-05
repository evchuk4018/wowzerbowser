import test from "node:test";
import assert from "node:assert/strict";
import { parseChatModeCommand } from "../lib/chat-modes.ts";
import { runSubagents } from "../app/server/agent/subagent-coordinator.ts";

test("deep research slash command is extracted from the prompt", () => {
  assert.deepEqual(parseChatModeCommand("/deep-research compare battery technologies"), {
    mode: "deep_research",
    content: "compare battery technologies",
  });
  assert.deepEqual(parseChatModeCommand("ordinary question"), { mode: "normal", content: "ordinary question" });
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
