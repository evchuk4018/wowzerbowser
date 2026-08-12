import "server-only";

import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { SearchProviderBlockedError, type SearchProviderName } from "./search-types";

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;
let blocked: { reasons: string[]; expiresAt: number } | undefined;

function currentBlockedReasons(): string[] | undefined {
  if (blocked && blocked.expiresAt <= Date.now()) blocked = undefined;
  return blocked?.reasons;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function scheduleSearXNGRequest<T>(
  provider: SearchProviderName,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const previous = requestQueue;
  requestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const beforeWait = currentBlockedReasons();
    if (beforeWait) throw new SearchProviderBlockedError(provider, beforeWait);
    const intervalMs = runtimeConfigSnapshot().searchProviderMinIntervalMs;
    await wait(Math.max(0, lastRequestStartedAt + intervalMs - Date.now()), signal);
    const afterWait = currentBlockedReasons();
    if (afterWait) throw new SearchProviderBlockedError(provider, afterWait);
    lastRequestStartedAt = Date.now();
    return await execute();
  } finally {
    release();
  }
}

export function markSearXNGBlocked(reasons: readonly string[]): void {
  blocked = {
    reasons: [...reasons],
    expiresAt: Date.now() + runtimeConfigSnapshot().searchProviderCircuitOpenMs,
  };
}

export function resetSearXNGRequestControl(): void {
  requestQueue = Promise.resolve();
  lastRequestStartedAt = 0;
  blocked = undefined;
}
