import "server-only";

import { getDatabase } from "../database/database";
import type { Sql } from "postgres";

export const CHAT_JOB_EVENTS_CHANNEL = "wowzerbowser_chat_events";

export type ChatJobEventNotification = {
  ownerId: string;
  conversationId: string;
  jobId: string;
};

export type ChatJobEventKey = ChatJobEventNotification;

type ListenRequest = ReturnType<Sql["listen"]>;
type Listen = (
  channel: string,
  onnotify: (value: string) => void,
  onlisten?: () => void,
) => ListenRequest;

export type ChatJobEventSubscription = {
  /** Resolves after PostgreSQL has accepted the LISTEN command. */
  ready: Promise<void>;
  /** Resolves when a notification for this exact job arrives or the wait signal aborts. */
  waitForNotification: (waitSignal?: AbortSignal) => Promise<void>;
  /** Removes this subscriber without closing the shared PostgreSQL listener. */
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function parseChatJobEventNotification(payload: string): ChatJobEventNotification | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const ownerId = value.ownerId;
  const conversationId = value.conversationId;
  const jobId = value.jobId;
  if (typeof ownerId !== "string" || typeof conversationId !== "string" || typeof jobId !== "string") return null;
  return { ownerId, conversationId, jobId };
}

function isForJob(notification: ChatJobEventNotification | null, key: ChatJobEventKey): boolean {
  return notification?.ownerId === key.ownerId
    && notification.conversationId === key.conversationId
    && notification.jobId === key.jobId;
}

/**
 * Create one job-scoped subscription over a shared postgres LISTEN channel.
 * The injected listener keeps lifecycle behavior testable without opening a
 * database connection in unit tests.
 */
export function createChatJobEventSubscription(
  listen: Listen,
  key: ChatJobEventKey,
  signal: AbortSignal,
): ChatJobEventSubscription {
  let pendingNotification = false;
  const waiters = new Set<() => void>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let listener: { unlisten: () => Promise<void> } | null = null;

  const onNotification = (payload: string): void => {
    if (closed) return;
    if (!isForJob(parseChatJobEventNotification(payload), key)) return;
    pendingNotification = true;
    for (const resolve of [...waiters]) resolve();
  };
  const onAbort = (): void => {
    pendingNotification = true;
    for (const resolve of [...waiters]) resolve();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const waitForNotification = (waitSignal?: AbortSignal): Promise<void> => {
    if (waitSignal?.aborted) return Promise.resolve();
    if (closed) return Promise.resolve();
    if (pendingNotification) {
      pendingNotification = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let active = true;
      const finish = (): void => {
        if (!active) return;
        active = false;
        waiters.delete(finish);
        waitSignal?.removeEventListener("abort", finish);
        resolve();
      };
      waiters.add(finish);
      waitSignal?.addEventListener("abort", finish, { once: true });
    });
  };

  let request: ListenRequest;
  try {
    request = listen(CHAT_JOB_EVENTS_CHANNEL, onNotification);
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    const ready = Promise.reject(error);
    void ready.catch(() => undefined);
    return {
      ready,
      waitForNotification,
      close: async () => undefined,
    };
  }
  void request.catch(() => undefined);

  const ready = request.then((result) => {
    listener = result;
  });
  void ready.catch(() => undefined);

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      for (const resolve of [...waiters]) resolve();
      try {
        if (listener) await listener.unlisten();
        else {
          const result = await request;
          await result.unlisten();
        }
      } catch {
        // A lost listener is already closed from the caller's perspective.
      }
    })();
    return closePromise;
  };

  return { ready, waitForNotification, close };
}

export function subscribeToChatJobEvents(
  key: ChatJobEventKey,
  signal: AbortSignal,
): ChatJobEventSubscription {
  const database = getDatabase();
  return createChatJobEventSubscription(database.listen.bind(database), key, signal);
}
