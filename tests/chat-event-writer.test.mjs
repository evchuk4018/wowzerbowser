import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncBatchWriter } from "../app/server/chat/chat-event-writer.ts";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("async batch writer preserves order and flushes at the batch limit", async () => {
  const batches = [];
  const writer = createAsyncBatchWriter(
    async (values) => {
      batches.push([...values]);
    },
    { batchSize: 3, flushIntervalMs: 1_000 },
  );

  writer.enqueue(1);
  writer.enqueue(2);
  writer.enqueue(3);
  await writer.drain();

  assert.deepEqual(batches, [[1, 2, 3]]);
});

test("enqueue does not wait for a slow batch persistence operation", async () => {
  const batches = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = createAsyncBatchWriter(
    async (values) => {
      batches.push([...values]);
      await gate;
    },
    { batchSize: 1, flushIntervalMs: 0 },
  );

  writer.enqueue("first");
  await wait(0);
  writer.enqueue("second");
  assert.deepEqual(batches, [["first"]]);

  release();
  await writer.drain();
  assert.deepEqual(batches, [["first"], ["second"]]);
});

test("drain surfaces persistence failures", async () => {
  const failure = new Error("database unavailable");
  const writer = createAsyncBatchWriter(
    async () => { throw failure; },
    { batchSize: 1, flushIntervalMs: 0 },
  );

  writer.enqueue("event");
  await assert.rejects(writer.drain(), failure);
  assert.throws(() => writer.enqueue("later"), failure);
});
