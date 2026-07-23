import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createDrawerGestureController } from "./drawer-gesture.mjs";

const MOBILE_DRAWER_MEDIA_QUERY = "(max-width: 760px)";
const CLICK_SUPPRESSION_MS = 700;

type GestureResult = {
  active: boolean;
  handled: boolean;
  horizontal: boolean;
  open?: boolean;
  preventDefault: boolean;
  progress: number | null;
  suppressClick: boolean;
};

export function useMobileDrawerGesture(onHorizontalIntent: () => void) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const appShellRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenRef = useRef(false);
  const controllerRef = useRef(createDrawerGestureController());
  const removeActiveListenersRef = useRef<(() => void) | null>(null);
  const suppressClickUntilRef = useRef(0);
  const onHorizontalIntentRef = useRef(onHorizontalIntent);

  useEffect(() => {
    onHorizontalIntentRef.current = onHorizontalIntent;
  }, [onHorizontalIntent]);

  const presentProgress = useCallback((progress: number, dragging: boolean) => {
    const shell = appShellRef.current;
    if (!shell) return;
    shell.style.setProperty("--drawer-progress", String(progress));
    shell.style.setProperty("--drawer-translate", `${(progress - 1) * 100}%`);
    shell.classList.toggle("drawer-dragging", dragging);
  }, []);

  const removeActiveListeners = useCallback(() => {
    removeActiveListenersRef.current?.();
    removeActiveListenersRef.current = null;
  }, []);

  const releasePointer = useCallback((pointerId: number) => {
    const shell = appShellRef.current;
    if (!shell) return;
    try {
      if (shell.hasPointerCapture(pointerId)) shell.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture can be lost between the check and release.
    }
  }, []);

  const settleSidebar = useCallback((open: boolean) => {
    removeActiveListeners();
    controllerRef.current.reset();
    sidebarOpenRef.current = open;
    presentProgress(open ? 1 : 0, false);
    setSidebarOpen(open);
  }, [presentProgress, removeActiveListeners]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") settleSidebar(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [settleSidebar]);

  useEffect(() => () => {
    removeActiveListeners();
    controllerRef.current.reset();
  }, [removeActiveListeners]);

  const completeGesture = useCallback((
    result: GestureResult,
    pointerId: number,
  ) => {
    if (!result.handled) return;
    removeActiveListeners();
    releasePointer(pointerId);
    if (result.progress === null) return;
    if (result.suppressClick) {
      suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESSION_MS;
    }
    if (result.open !== undefined) {
      sidebarOpenRef.current = result.open;
      setSidebarOpen(result.open);
    }
    presentProgress(result.progress, false);
  }, [presentProgress, releasePointer, removeActiveListeners]);

  const handlePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // A new intentional pointer sequence must never inherit click suppression
    // from the preceding horizontal gesture.
    suppressClickUntilRef.current = 0;
    if (!window.matchMedia(MOBILE_DRAWER_MEDIA_QUERY).matches) return;

    const drawerWidth = sidebarRef.current?.getBoundingClientRect().width ?? 0;
    const started = controllerRef.current.start({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      x: event.clientX,
      y: event.clientY,
      width: drawerWidth,
      open: sidebarOpenRef.current,
    }) as GestureResult;
    if (!started.active) return;

    const shell = appShellRef.current;
    if (shell) {
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        // Document listeners retain ownership if pointer capture is unavailable.
      }
    }

    const move = (pointerEvent: PointerEvent) => {
      const result = controllerRef.current.move({
        pointerId: pointerEvent.pointerId,
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
        width: drawerWidth,
      }) as GestureResult;
      if (!result.handled) return;
      if (!result.active && !result.horizontal) {
        removeActiveListeners();
        releasePointer(pointerEvent.pointerId);
        return;
      }
      if (!result.horizontal || result.progress === null) return;

      if (result.preventDefault) pointerEvent.preventDefault();
      onHorizontalIntentRef.current();
      presentProgress(result.progress, true);
    };

    const finish = (pointerEvent: PointerEvent) => {
      const result = controllerRef.current.finish({
        pointerId: pointerEvent.pointerId,
      }) as GestureResult;
      if (result.preventDefault) pointerEvent.preventDefault();
      completeGesture(result, pointerEvent.pointerId);
    };

    const cancel = (pointerEvent: PointerEvent) => {
      const result = controllerRef.current.cancel({
        pointerId: pointerEvent.pointerId,
      }) as GestureResult;
      completeGesture(result, pointerEvent.pointerId);
    };

    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", finish, { capture: true, passive: false });
    document.addEventListener("pointercancel", cancel, { capture: true, passive: false });
    removeActiveListenersRef.current = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, [completeGesture, presentProgress, releasePointer, removeActiveListeners]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (performance.now() > suppressClickUntilRef.current) return;
    suppressClickUntilRef.current = 0;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    appShellRef,
    handleClickCapture,
    handlePointerDownCapture,
    setSidebarOpen: settleSidebar,
    sidebarOpen,
    sidebarRef,
  };
}
