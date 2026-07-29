"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  MOBILE_HISTORY_CLICK_SUPPRESSION_MS,
  MobileHistorySwipeGesture,
} from "./mobile-history-swipe";

export type MobileHistoryNavigationOptions = {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  onSidebarOpen: () => void;
  onSidebarClose: () => void;
  /** Called before opening the sidebar, e.g. to close transient menus. */
  onBeforeSidebarOpen?: () => void;
};

export type MobileHistoryNavigationHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * Owns the mobile history swipe lifecycle and returns handlers for the shell.
 * The gesture class remains responsible for touch intent, thresholds, and
 * click suppression; this hook only connects it to React and sidebar state.
 */
export function useMobileHistoryNavigation({
  sidebarOpen,
  settingsOpen,
  onSidebarOpen,
  onSidebarClose,
  onBeforeSidebarOpen,
}: MobileHistoryNavigationOptions): MobileHistoryNavigationHandlers {
  const gestureRef = useRef(new MobileHistorySwipeGesture());
  const clickResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const resetMobileHistorySwipe = () => {
      gestureRef.current.cancel();
      if (clickResetTimerRef.current !== null) {
        window.clearTimeout(clickResetTimerRef.current);
        clickResetTimerRef.current = null;
      }
    };

    window.addEventListener("blur", resetMobileHistorySwipe);
    window.addEventListener("resize", resetMobileHistorySwipe);
    return () => {
      window.removeEventListener("blur", resetMobileHistorySwipe);
      window.removeEventListener("resize", resetMobileHistorySwipe);
      resetMobileHistorySwipe();
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) gestureRef.current.cancel();
  }, [settingsOpen]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    gestureRef.current.begin({
      clientX: event.clientX,
      clientY: event.clientY,
      disabled: settingsOpen,
      isPrimary: event.isPrimary,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      sidebarOpen,
      viewportWidth: window.innerWidth,
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    gestureRef.current.move({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
    });
  };

  const scheduleClickSuppressionReset = () => {
    if (!gestureRef.current.hasClickSuppression()) return;
    if (clickResetTimerRef.current !== null) {
      window.clearTimeout(clickResetTimerRef.current);
    }
    clickResetTimerRef.current = window.setTimeout(() => {
      gestureRef.current.clearClickSuppression();
      clickResetTimerRef.current = null;
    }, MOBILE_HISTORY_CLICK_SUPPRESSION_MS);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gestureRef.current.isTrackingPointer(event.pointerId)) return;
    if (window.getSelection()?.isCollapsed === false) {
      gestureRef.current.cancel(event.pointerId);
      return;
    }
    const action = gestureRef.current.end({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
    });
    if (action === "open") {
      onBeforeSidebarOpen?.();
      onSidebarOpen();
    } else if (action === "close") {
      onSidebarClose();
    }
    scheduleClickSuppressionReset();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    gestureRef.current.cancel(event.pointerId);
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!gestureRef.current.consumeClickSuppression()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onClickCapture: handleClickCapture,
  };
}
