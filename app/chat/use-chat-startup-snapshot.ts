"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChatStartupSnapshot,
  parseChatStartupSnapshot,
  type ChatStartupSnapshotInput,
  type ChatStartupSnapshotV1,
} from "../../lib/chat-startup-snapshot";
import {
  deleteChatStartupSnapshot,
  readChatStartupSnapshot,
  writeChatStartupSnapshot,
} from "./chat-startup-snapshot-store";

const SNAPSHOT_WRITE_DELAY_MS = 900;

function scheduleIdle(callback: () => void): number {
  const browserWindow = globalThis as unknown as Window;
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    return (window as Window & {
      requestIdleCallback: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback(callback, { timeout: 1_500 });
  }
  return browserWindow.setTimeout(callback, 0);
}

function cancelIdle(handle: number | null): void {
  if (handle === null || typeof window === "undefined") return;
  const browserWindow = globalThis as unknown as Window;
  if ("cancelIdleCallback" in window) {
    (window as Window & { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(handle);
  } else {
    browserWindow.clearTimeout(handle);
  }
}

export type UseChatStartupSnapshotResult = {
  snapshot: ChatStartupSnapshotV1 | null;
  snapshotLoaded: boolean;
  persistSnapshot: (input: ChatStartupSnapshotInput) => void;
  flushSnapshot: () => Promise<void>;
};

export function useChatStartupSnapshot(userId: string): UseChatStartupSnapshotResult {
  const [snapshot, setSnapshot] = useState<ChatStartupSnapshotV1 | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const mountedRef = useRef(true);
  const userIdRef = useRef(userId);
  const pendingSnapshotRef = useRef<ChatStartupSnapshotV1 | null>(null);
  const delayRef = useRef<number | null>(null);
  const idleRef = useRef<number | null>(null);
  const writeRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    userIdRef.current = userId;
    // Reset the user-scoped read state before starting the next IndexedDB read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(null);
    setSnapshotLoaded(false);
    let active = true;
    void readChatStartupSnapshot(userId)
      .then((value) => parseChatStartupSnapshot(value, userId))
      .then((parsed) => {
        if (!active || !mountedRef.current || userIdRef.current !== userId) return;
        setSnapshot(parsed);
        setSnapshotLoaded(true);
      })
      .catch(() => {
        if (!active || !mountedRef.current || userIdRef.current !== userId) return;
        setSnapshot(null);
        setSnapshotLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const flushSnapshot = useCallback(async () => {
    if (delayRef.current !== null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    cancelIdle(idleRef.current);
    idleRef.current = null;
    const pending = pendingSnapshotRef.current;
    pendingSnapshotRef.current = null;
    if (!pending || pending.userId !== userIdRef.current) return;
    const write = writeChatStartupSnapshot(pending).catch(() => undefined);
    writeRef.current = write;
    await write;
    if (writeRef.current === write) writeRef.current = null;
  }, []);

  const persistSnapshot = useCallback((input: ChatStartupSnapshotInput) => {
    if (input.userId !== userIdRef.current) return;
    pendingSnapshotRef.current = createChatStartupSnapshot(input);
    if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    delayRef.current = window.setTimeout(() => {
      delayRef.current = null;
      idleRef.current = scheduleIdle(() => {
        idleRef.current = null;
        void flushSnapshot();
      });
    }, SNAPSHOT_WRITE_DELAY_MS);
  }, [flushSnapshot]);

  useEffect(() => {
    const flush = () => void flushSnapshot();
    window.addEventListener("pagehide", flush);
    window.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("visibilitychange", flush);
    };
  }, [flushSnapshot]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    cancelIdle(idleRef.current);
    pendingSnapshotRef.current = null;
    void writeRef.current;
  }, []);

  return { snapshot, snapshotLoaded, persistSnapshot, flushSnapshot };
}

export async function clearChatStartupSnapshot(userId: string): Promise<void> {
  await deleteChatStartupSnapshot(userId).catch(() => undefined);
}
