import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTodoList, MAX_TODOS } from "../lib/todo-protocol.ts";
import { TODO_TOOL_DEFINITIONS, GET_TODOS_TOOL_NAME, COMPLETE_TODO_TOOL_NAME } from "../app/server/agent/todo-tool.ts";
import { shouldPlanTodos } from "../app/server/chat/chat-todo-planner.ts";
import { applyChatStreamEvent } from "../lib/chat-history.ts";

test("todo protocol bounds, normalizes, and orders five items", () => {
  const list = normalizeTodoList({ items: [
    { id: "one", text: " First ", status: "completed" },
    { id: "one", text: "duplicate" },
    { id: "two", text: "Second" },
    { id: "three", text: "Third" },
    { id: "four", text: "Fourth" },
    { id: "five", text: "Fifth" },
    { id: "six", text: "Sixth" },
  ] });
  assert.equal(MAX_TODOS, 5);
  assert.deepEqual(list.items.map(({ id, position }) => [id, position]), [["one", 0], ["two", 1], ["three", 2], ["four", 3], ["five", 4]]);
  assert.equal(list.items[0].status, "completed");
});

test("todo tools expose read and complete without add/edit operations", () => {
  assert.deepEqual(TODO_TOOL_DEFINITIONS.map((tool) => tool.function.name), [GET_TODOS_TOOL_NAME, COMPLETE_TODO_TOOL_NAME]);
  assert.equal(TODO_TOOL_DEFINITIONS[1].function.parameters.required[0], "todoId");
});

test("todo planning is reserved for substantial work", () => {
  const empty = { revision: 0, items: [] };
  const active = { revision: 1, items: [{ id: "research", text: "Research the topic", status: "pending", position: 0 }] };

  assert.equal(shouldPlanTodos("What is 2 + 2?", empty), false);
  assert.equal(shouldPlanTodos("Help me solve this calculus problem and explain each step.", empty), false);
  assert.equal(shouldPlanTodos("Explain how photosynthesis works.", empty), false);
  assert.equal(shouldPlanTodos("Do a deep research dive into the history of renewable energy and compare the major sources.", empty), true);
  assert.equal(shouldPlanTodos("Research this topic, compare the sources, and create a detailed document with citations.", empty), true);
  assert.equal(shouldPlanTodos("Build a complete migration plan for our production database and rollout workflow.", empty), true);
  assert.equal(shouldPlanTodos("What is 2 + 2?", active), false);
  assert.equal(shouldPlanTodos("Continue by updating the research report with the new sources.", active), true);
});

test("todo updates are durable through the chat event projection", () => {
  const message = { id: "assistant", role: "assistant", content: "", status: "streaming" };
  const todos = { revision: 1, items: [{ id: "one", text: "Do one", status: "pending", position: 0 }] };
  assert.deepEqual(applyChatStreamEvent(message, { type: "todo_update", todos }, 1).todos, todos);
});
