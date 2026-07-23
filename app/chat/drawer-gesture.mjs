export const DRAWER_DIRECTION_LOCK_PX = 8;
export const DRAWER_SETTLE_THRESHOLD = 0.25;

const clampProgress = (progress) => Math.min(1, Math.max(0, progress));

const settleOpenState = (startProgress, progress, settleThreshold) => {
  const crossedThreshold = startProgress === 0
    ? progress >= settleThreshold
    : progress <= 1 - settleThreshold;
  return crossedThreshold
    ? startProgress === 0
    : startProgress === 1;
};

export function createDrawerGestureController({
  directionLockPx = DRAWER_DIRECTION_LOCK_PX,
  settleThreshold = DRAWER_SETTLE_THRESHOLD,
} = {}) {
  let gesture = null;

  const inactiveResult = () => ({
    active: false,
    handled: false,
    horizontal: false,
    preventDefault: false,
    progress: null,
    suppressClick: false,
  });

  return {
    start({ pointerId, pointerType, isPrimary, x, y, width, open }) {
      if (
        gesture
        || !isPrimary
        || (pointerType !== "touch" && pointerType !== "pen")
        || !Number.isFinite(width)
        || width <= 0
      ) {
        return inactiveResult();
      }

      const startProgress = open ? 1 : 0;
      gesture = {
        axis: "pending",
        pointerId,
        startProgress,
        startX: x,
        startY: y,
        progress: startProgress,
      };

      return {
        ...inactiveResult(),
        active: true,
        handled: true,
        progress: startProgress,
      };
    },

    move({ pointerId, x, y, width }) {
      if (!gesture || gesture.pointerId !== pointerId) return inactiveResult();

      const deltaX = x - gesture.startX;
      const deltaY = y - gesture.startY;

      if (gesture.axis === "pending") {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < directionLockPx) {
          return {
            ...inactiveResult(),
            active: true,
            handled: true,
            progress: gesture.progress,
          };
        }

        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          const progress = gesture.startProgress;
          gesture = null;
          return {
            ...inactiveResult(),
            handled: true,
            progress,
          };
        }

        gesture.axis = "horizontal";
      }

      gesture.progress = clampProgress(gesture.startProgress + deltaX / width);
      return {
        active: true,
        handled: true,
        horizontal: true,
        preventDefault: true,
        progress: gesture.progress,
        suppressClick: true,
      };
    },

    finish({ pointerId }) {
      if (!gesture || gesture.pointerId !== pointerId) return inactiveResult();

      const completed = gesture;
      gesture = null;
      if (completed.axis !== "horizontal") {
        return {
          ...inactiveResult(),
          handled: true,
          open: completed.startProgress === 1,
          progress: completed.startProgress,
        };
      }

      const open = settleOpenState(
        completed.startProgress,
        completed.progress,
        settleThreshold,
      );

      return {
        active: false,
        handled: true,
        horizontal: true,
        open,
        preventDefault: true,
        progress: open ? 1 : 0,
        suppressClick: true,
      };
    },

    cancel({ pointerId }) {
      if (!gesture || gesture.pointerId !== pointerId) return inactiveResult();

      const cancelled = gesture;
      gesture = null;
      const horizontal = cancelled.axis === "horizontal";
      const open = horizontal
        ? settleOpenState(cancelled.startProgress, cancelled.progress, settleThreshold)
        : cancelled.startProgress === 1;
      return {
        active: false,
        handled: true,
        horizontal,
        open,
        preventDefault: horizontal,
        progress: open ? 1 : 0,
        suppressClick: horizontal,
      };
    },

    reset() {
      gesture = null;
    },

    isActive() {
      return gesture !== null;
    },
  };
}
