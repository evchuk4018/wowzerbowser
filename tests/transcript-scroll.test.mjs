import assert from "node:assert/strict";
import test from "node:test";
import { isTranscriptNearBottom } from "../app/chat/transcript-scroll.ts";

const metricsWithRemainingDistance = (remainingDistance) => ({
  scrollHeight: 1_000,
  scrollTop: 500 - remainingDistance,
  clientHeight: 500,
});

test("is near the bottom when no distance remains", () => {
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(0)), true);
});

test("allows one pixel of browser rounding tolerance", () => {
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(1)), true);
});

test("small upward touchpad movement disables auto-scroll", () => {
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(2)), false);
});

test("is near the bottom when the remaining distance is negative", () => {
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(-1)), true);
});

test("honors a custom threshold", () => {
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(25), 24), false);
  assert.equal(isTranscriptNearBottom(metricsWithRemainingDistance(25), 25), true);
});
