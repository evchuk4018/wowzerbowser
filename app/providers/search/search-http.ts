import "server-only";

const DEFAULT_TIMEOUT_MS = 12_000;

export async function searchRequest(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, { ...init, signal: requestSignal });
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
