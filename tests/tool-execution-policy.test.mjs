import assert from "node:assert/strict";
import test from "node:test";
import {
  executeToolBatch,
  planToolBatches,
  toolExecutionMetadata,
} from "../app/server/agent/tool-execution-policy.ts";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("groups only adjacent parallel-safe calls and leaves serial calls as barriers", () => {
  const calls = [
    { name: "search_document" },
    { name: "read_document_pages" },
    { name: "complete_todo" },
    { name: "check_time" },
  ];
  const batches = planToolBatches(calls, (call) => toolExecutionMetadata(call.name).executionPolicy);
  assert.deepEqual(batches.map((batch) => batch.map((call) => call.name)), [
    ["search_document", "read_document_pages"],
    ["complete_todo"],
    ["check_time"],
  ]);
});

test("executes a parallel batch with a bounded worker count and preserves result order", async () => {
  const calls = ["first", "second", "third", "fourth", "fifth"];
  let active = 0;
  let maximumActive = 0;
  const settled = await executeToolBatch(calls, async (call) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(call === "first" ? 15 : 1);
    active -= 1;
    return call.toUpperCase();
  }, new AbortController().signal, 2);

  assert.equal(maximumActive, 2);
  assert.deepEqual(settled.map((item) => item.status === "fulfilled" ? item.value : item.reason), [
    "FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH",
  ]);
});

test("one failed parallel call does not cancel its peers", async () => {
  const failure = new Error("one tool failed");
  const settled = await executeToolBatch(["bad", "good"], async (call) => {
    await delay(1);
    if (call === "bad") throw failure;
    return "completed";
  }, new AbortController().signal, 2);

  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[0].reason, failure);
  assert.deepEqual(settled[1], { status: "fulfilled", value: "completed" });
});

test("cancellation prevents work that has not started", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const executed = [];
  const settled = await executeToolBatch([1, 2], async (value) => {
    executed.push(value);
    return value;
  }, controller.signal, 2);

  assert.deepEqual(executed, []);
  assert.deepEqual(settled.map((item) => item.status), ["rejected", "rejected"]);
});

test("connector reads are parallel-safe while writes default to serial", () => {
  const read = { namespacedName: "connector__drive__list_files", access: "read" };
  const write = { namespacedName: "connector__drive__create_file", access: "write" };
  assert.equal(toolExecutionMetadata(read.namespacedName, [read]).executionPolicy, "parallel-safe");
  assert.equal(toolExecutionMetadata(write.namespacedName, [write]).executionPolicy, "serial");
  assert.equal(toolExecutionMetadata("connector__drive__unknown", []).executionPolicy, "serial");
});

test("full-page PDF visual inspection is parallel-safe", () => {
  assert.equal(toolExecutionMetadata("inspect_document_page").executionPolicy, "parallel-safe");
  assert.equal(toolExecutionMetadata("inspect_document_pages").executionPolicy, "parallel-safe");
  assert.equal(toolExecutionMetadata("inspect_workspace_pdf").executionPolicy, "parallel-safe");
});
