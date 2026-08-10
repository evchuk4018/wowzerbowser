import assert from "node:assert/strict";
import test from "node:test";
import { chatRetryDelayMs } from "../app/chat/chat-retry-backoff.ts";
import { isTransientChatPersistenceError, withChatPersistenceRetry } from "../app/server/chat/chat-persistence-retry.ts";
import { chatHeartbeatAction } from "../app/server/chat/chat-job-runner.ts";

test("chat heartbeat only stops execution for authoritative cancellation or lease loss", () => {
  assert.equal(chatHeartbeatAction({ active: true }), "continue");
  assert.equal(chatHeartbeatAction({ active: true, cancelled: true }), "cancel");
  assert.equal(chatHeartbeatAction({ active: false, status: "missing" }), "lease_lost");
});

test("chat recovery backoff is bounded and jittered", () => {
  assert.equal(chatRetryDelayMs(0, { initialMs: 300, maxMs: 1500, random: () => 0 }), 240);
  assert.equal(chatRetryDelayMs(1, { initialMs: 300, maxMs: 1500, random: () => 1 }), 720);
  assert.equal(chatRetryDelayMs(20, { initialMs: 300, maxMs: 1500, random: () => 0.5 }), 1500);
});

test("persistence retries transient failures but not uniqueness failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await withChatPersistenceRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw { code: "40001" };
    return "ok";
  }, { baseDelayMs: 1, random: () => 0.5, sleep: async (milliseconds) => sleeps.push(milliseconds) });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1, 2]);
  assert.equal(isTransientChatPersistenceError({ code: "23505" }), false);
  await assert.rejects(
    withChatPersistenceRetry(async () => { throw { code: "23505" }; }, { sleep: async () => { throw new Error("should not sleep"); } }),
    (error) => error?.code === "23505",
  );
});
