import "server-only";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 25;

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, RETRY_DELAY_MS);
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const externalSignal = signal ?? init.signal ?? undefined;
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      const response = await fetch(url, { ...init, signal: requestSignal });
      if (attempt < MAX_ATTEMPTS && transientStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await waitForRetry(externalSignal);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || externalSignal?.aborted) throw error;
      await waitForRetry(externalSignal);
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
