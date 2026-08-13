import "server-only";

import { isRetryableDatabaseError } from "../database/database";

export type ChatPersistenceRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function isTransientChatPersistenceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; name?: unknown };
  if (isRetryableDatabaseError(error)) return true;
  if (typeof value.status === "number" && (value.status === 408 || value.status === 429 || value.status >= 500)) return true;
  return value.name === "FetchError" || value.name === "AbortError";
}

function retryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  return Math.max(0, Math.round(ceiling * (0.8 + random() * 0.4)));
}

/** Retry only transient database failures; uniqueness and validation errors remain terminal. */
export async function withChatPersistenceRetry<T>(
  operation: () => Promise<T>,
  options: ChatPersistenceRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 50));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? 500));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (attempt >= attempts || !isTransientChatPersistenceError(error)) throw error;
      await sleep(retryDelay(attempt - 1, baseDelayMs, maxDelayMs, random));
    }
  }
}
