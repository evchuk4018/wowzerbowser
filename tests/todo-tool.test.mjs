import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTodoList, MAX_TODOS } from "../lib/todo-protocol.ts";
import { TODO_TOOL_DEFINITIONS, GET_TODOS_TOOL_NAME, COMPLETE_TODO_TOOL_NAME } from "../app/server/agent/todo-tool.ts";
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

test("todo updates are durable through the chat event projection", () => {
  const message = { id: "assistant", role: "assistant", content: "", status: "streaming" };
  const todos = { revision: 1, items: [{ id: "one", text: "Do one", status: "pending", position: 0 }] };
  assert.deepEqual(applyChatStreamEvent(message, { type: "todo_update", todos }, 1).todos, todos);
});
