import "server-only";

/** A deliberately opaque provider error: credentials and retry details stay server-side. */
export class WebProviderError extends Error {
  constructor() { super("The web information service is temporarily unavailable."); }
}

export function keysFor(multiple: string | undefined, single: string | undefined): string[] {
  return [...new Set([...(multiple ?? "").split(/[\n,]/), single ?? ""]
    .map((key) => key.trim()).filter(Boolean))];
}

export function configuredKeys(provider: "brave" | "exa"): string[] {
  return provider === "brave"
    ? keysFor(process.env.BRAVE_API_KEYS, process.env.BRAVE_API_KEY)
    : keysFor(process.env.EXA_API_KEYS, process.env.EXA_API_KEY);
}

export async function withProviderKeys<T>(keys: readonly string[], request: (key: string) => Promise<T>): Promise<T> {
  for (const key of keys) {
    try { return await request(key); } catch (error) {
      const status = error instanceof Response ? error.status : 0;
      // Only provider failures that can plausibly be key/account/network related fail over.
      if (![0, 401, 403, 408, 429, 500, 502, 503, 504].includes(status)) throw error;
    }
  }
  throw new WebProviderError();
}
