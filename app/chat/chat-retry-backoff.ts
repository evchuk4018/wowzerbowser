export const CHAT_RECOVERY_INITIAL_DELAY_MS = 300;
export const CHAT_RECOVERY_MAX_DELAY_MS = 1_500;

export function chatRetryDelayMs(
  attempt: number,
  options: { initialMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const initialMs = Math.max(0, options.initialMs ?? CHAT_RECOVERY_INITIAL_DELAY_MS);
  const maxMs = Math.max(initialMs, options.maxMs ?? CHAT_RECOVERY_MAX_DELAY_MS);
  const random = options.random ?? Math.random;
  const ceiling = Math.min(maxMs, initialMs * (2 ** Math.max(0, attempt)));
  return Math.max(0, Math.round(ceiling * (0.8 + random() * 0.4)));
}

export function waitForChatRetry(
  signal: AbortSignal,
  attempt: number,
  options: { initialMs?: number; maxMs?: number; random?: () => number } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(true), chatRetryDelayMs(attempt, options));
    const onAbort = () => finish(false);
    const finish = (shouldContinue: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(shouldContinue);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
