export const MOBILE_HISTORY_MAX_WIDTH = 760;
export const MOBILE_HISTORY_SWIPE_THRESHOLD = 0.25;
export const MOBILE_HISTORY_HORIZONTAL_INTENT_PX = 10;
export const MOBILE_HISTORY_CLICK_SUPPRESSION_MS = 500;

export type MobileHistorySwipeAction = "open" | "close" | null;

type SwipeCoordinates = {
  clientX: number;
  clientY: number;
  pointerId: number;
};

type SwipeStart = SwipeCoordinates & {
  disabled: boolean;
  isPrimary: boolean;
  pointerType: string;
  sidebarOpen: boolean;
  viewportWidth: number;
};

type SwipeDecision = {
  deltaX: number;
  deltaY: number;
  sidebarOpen: boolean;
  viewportWidth: number;
};

type ActiveSwipe = {
  horizontalIntent: boolean;
  pointerId: number;
  sidebarOpen: boolean;
  startX: number;
  startY: number;
  viewportWidth: number;
};

export function getMobileHistorySwipeAction({
  deltaX,
  deltaY,
  sidebarOpen,
  viewportWidth,
}: SwipeDecision): MobileHistorySwipeAction {
  if (viewportWidth <= 0 || viewportWidth > MOBILE_HISTORY_MAX_WIDTH) return null;

  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance < viewportWidth * MOBILE_HISTORY_SWIPE_THRESHOLD
    || horizontalDistance <= Math.abs(deltaY)
  ) {
    return null;
  }

  if (deltaX > 0 && !sidebarOpen) return "open";
  if (deltaX < 0 && sidebarOpen) return "close";
  return null;
}

export class MobileHistorySwipeGesture {
  private activeSwipe: ActiveSwipe | null = null;
  private suppressClick = false;

  begin({
    clientX,
    clientY,
    disabled,
    isPrimary,
    pointerId,
    pointerType,
    sidebarOpen,
    viewportWidth,
  }: SwipeStart): boolean {
    if (this.activeSwipe && this.activeSwipe.pointerId !== pointerId) return false;
    this.cancel();
    if (
      disabled
      || pointerType !== "touch"
      || !isPrimary
      || viewportWidth <= 0
      || viewportWidth > MOBILE_HISTORY_MAX_WIDTH
    ) {
      return false;
    }

    this.activeSwipe = {
      horizontalIntent: false,
      pointerId,
      sidebarOpen,
      startX: clientX,
      startY: clientY,
      viewportWidth,
    };
    return true;
  }

  move({ clientX, clientY, pointerId }: SwipeCoordinates): boolean {
    const activeSwipe = this.activeSwipe;
    if (!activeSwipe || pointerId !== activeSwipe.pointerId) return false;

    const horizontalDistance = Math.abs(clientX - activeSwipe.startX);
    const verticalDistance = Math.abs(clientY - activeSwipe.startY);
    if (
      !activeSwipe.horizontalIntent
      && horizontalDistance >= MOBILE_HISTORY_HORIZONTAL_INTENT_PX
      && horizontalDistance > verticalDistance
    ) {
      activeSwipe.horizontalIntent = true;
      this.suppressClick = true;
    }

    return activeSwipe.horizontalIntent;
  }

  isTrackingPointer(pointerId: number): boolean {
    return this.activeSwipe?.pointerId === pointerId;
  }

  end({ clientX, clientY, pointerId }: SwipeCoordinates): MobileHistorySwipeAction {
    const activeSwipe = this.activeSwipe;
    if (!activeSwipe || pointerId !== activeSwipe.pointerId) return null;

    const action = activeSwipe.horizontalIntent
      ? getMobileHistorySwipeAction({
          deltaX: clientX - activeSwipe.startX,
          deltaY: clientY - activeSwipe.startY,
          sidebarOpen: activeSwipe.sidebarOpen,
          viewportWidth: activeSwipe.viewportWidth,
        })
      : null;
    this.activeSwipe = null;
    return action;
  }

  cancel(pointerId?: number): boolean {
    if (pointerId !== undefined && !this.isTrackingPointer(pointerId)) return false;
    this.activeSwipe = null;
    this.suppressClick = false;
    return true;
  }

  hasClickSuppression(): boolean {
    return this.suppressClick;
  }

  consumeClickSuppression(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  clearClickSuppression(): void {
    this.suppressClick = false;
  }
}
