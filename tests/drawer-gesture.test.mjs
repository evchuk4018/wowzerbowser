import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAWER_SETTLE_THRESHOLD,
  createDrawerGestureController,
} from "../app/chat/drawer-gesture.mjs";

const start = (controller, {
  open = false,
  pointerId = 1,
  pointerType = "touch",
  x = 180,
  y = 240,
  width = 300,
  isPrimary = true,
} = {}) => controller.start({
  open,
  pointerId,
  pointerType,
  x,
  y,
  width,
  isPrimary,
});

test("a rightward touch sequence from a non-edge point progressively opens at 25%", () => {
  const controller = createDrawerGestureController();
  assert.equal(DRAWER_SETTLE_THRESHOLD, 0.25);
  assert.equal(start(controller).active, true);

  const firstMove = controller.move({ pointerId: 1, x: 210, y: 242, width: 300 });
  assert.equal(firstMove.horizontal, true);
  assert.equal(firstMove.preventDefault, true);
  assert.equal(firstMove.suppressClick, true);
  assert.equal(firstMove.progress, 0.1);

  const thresholdMove = controller.move({ pointerId: 1, x: 255, y: 243, width: 300 });
  assert.equal(thresholdMove.progress, 0.25);

  const finished = controller.finish({ pointerId: 1 });
  assert.equal(finished.open, true);
  assert.equal(finished.progress, 1);
  assert.equal(finished.suppressClick, true);
});

test("a rightward drag below the threshold returns a closed drawer to its origin", () => {
  const controller = createDrawerGestureController();
  start(controller, { x: 320 });
  const moved = controller.move({ pointerId: 1, x: 380, y: 240, width: 300 });
  assert.equal(moved.progress, 0.2);

  const finished = controller.finish({ pointerId: 1 });
  assert.equal(finished.open, false);
  assert.equal(finished.progress, 0);
});

test("the same viewport gesture progressively closes with a leftward swipe", () => {
  const controller = createDrawerGestureController();
  start(controller, { open: true, x: 260 });

  const moved = controller.move({ pointerId: 1, x: 185, y: 238, width: 300 });
  assert.equal(moved.horizontal, true);
  assert.equal(moved.progress, 0.75);

  const finished = controller.finish({ pointerId: 1 });
  assert.equal(finished.open, false);
  assert.equal(finished.progress, 0);
});

test("a short closing drag restores the fully open state", () => {
  const controller = createDrawerGestureController();
  start(controller, { open: true, x: 250 });
  controller.move({ pointerId: 1, x: 190, y: 240, width: 300 });

  const finished = controller.finish({ pointerId: 1 });
  assert.equal(finished.open, true);
  assert.equal(finished.progress, 1);
});

test("vertical intent abandons drawer handling without preventing native scrolling", () => {
  const controller = createDrawerGestureController();
  start(controller);

  const pending = controller.move({ pointerId: 1, x: 184, y: 245, width: 300 });
  assert.equal(pending.active, true);
  assert.equal(pending.preventDefault, false);

  const vertical = controller.move({ pointerId: 1, x: 186, y: 270, width: 300 });
  assert.equal(vertical.active, false);
  assert.equal(vertical.horizontal, false);
  assert.equal(vertical.preventDefault, false);
  assert.equal(vertical.progress, 0);
  assert.equal(controller.isActive(), false);
});

test("progress remains continuous and clamped while event targets can change", () => {
  const controller = createDrawerGestureController();
  start(controller, { x: 420 });

  const overMessage = controller.move({
    pointerId: 1,
    x: 450,
    y: 240,
    width: 300,
    targetRegion: "assistant-message",
  });
  const overStreamingThinking = controller.move({
    pointerId: 1,
    x: 570,
    y: 243,
    width: 300,
    targetRegion: "streaming-thinking-overlay",
  });
  const overComposer = controller.move({
    pointerId: 1,
    x: 900,
    y: 244,
    width: 300,
    targetRegion: "composer",
  });

  assert.equal(overMessage.progress, 0.1);
  assert.equal(overStreamingThinking.progress, 0.5);
  assert.equal(overComposer.progress, 1);
  assert.equal(controller.finish({ pointerId: 1 }).open, true);
});

test("cancelling after horizontal intent restores the starting state and suppresses its click", () => {
  const controller = createDrawerGestureController();
  start(controller, { open: true });
  controller.move({ pointerId: 1, x: 120, y: 240, width: 300 });

  const cancelled = controller.cancel({ pointerId: 1 });
  assert.equal(cancelled.open, true);
  assert.equal(cancelled.progress, 1);
  assert.equal(cancelled.suppressClick, true);
  assert.equal(controller.isActive(), false);
});

test("non-primary, mouse, invalid, and competing pointers do not take over", () => {
  const controller = createDrawerGestureController();
  assert.equal(start(controller, { isPrimary: false }).active, false);
  assert.equal(start(controller, { pointerType: "mouse" }).active, false);
  assert.equal(start(controller, { width: 0 }).active, false);

  assert.equal(start(controller, { pointerType: "pen", pointerId: 7 }).active, true);
  assert.equal(start(controller, { pointerId: 8 }).active, false);
  assert.equal(
    controller.move({ pointerId: 8, x: 300, y: 240, width: 300 }).handled,
    false,
  );
  assert.equal(controller.cancel({ pointerId: 7 }).handled, true);
});
