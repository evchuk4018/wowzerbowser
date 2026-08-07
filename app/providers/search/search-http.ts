import "server-only";

import { runtimeConfigSnapshot } from "../../server/config/runtime-config-service";

const MAX_SAFE_TIMEOUT_MS = 60_000;
const MAX_SAFE_ATTEMPTS = 4;
const MAX_SAFE_RETRY_DELAY_MS = 5_000;

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForRetry(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
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
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function searchRequest(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<Response> {
  const externalSignal = signal ?? init.signal ?? undefined;
  const configuration = runtimeConfigSnapshot();
  const requestTimeoutMs = Math.min(timeoutMs ?? configuration.searchProviderRequestTimeoutMs, MAX_SAFE_TIMEOUT_MS);
  const maxAttempts = Math.min(configuration.searchProviderMaxAttempts, MAX_SAFE_ATTEMPTS);
  const retryDelayMs = Math.min(configuration.searchProviderRetryDelayMs, MAX_SAFE_RETRY_DELAY_MS);
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      const response = await fetch(url, { ...init, signal: requestSignal });
      if (attempt < maxAttempts && transientStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await waitForRetry(externalSignal, retryDelayMs);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxAttempts || externalSignal?.aborted) throw error;
      await waitForRetry(externalSignal, retryDelayMs);
    }
  }
  throw new Error("Search request failed after retries.");
}

export function text(value: unknown, maximum = 2_000): string {
  if (typeof value === "string") return value.trim().slice(0, maximum);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, maximum);
  return "";
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function requireOk(response: Response, provider: string): void {
  if (!response.ok) throw new Error(`${provider} search failed with status ${response.status}.`);
}
