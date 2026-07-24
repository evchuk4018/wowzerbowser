/**
 * Return the maximum duration that a single Python subprocess may be given.
 *
 * A tool call has its own 60-second budget, while the chat response also has
 * an absolute deadline. Callers pass the earlier of those absolute deadlines
 * so every subprocess in one tool call shares the same remaining budget.
 */
export function boundedPythonTimeoutMs(
  requestedMs: number,
  deadlineAt: number,
  now = Date.now(),
  callTimeoutMs = 60_000,
): number {
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0) return 0;
  const boundedMs = Math.min(requestedMs, callTimeoutMs, remainingMs);
  // Modal requires subprocess timeouts to be whole seconds. Round down so
  // the timeout never extends beyond the requested absolute deadline.
  return Math.floor(boundedMs / 1_000) * 1_000;
}

/** Bound an asynchronous remote operation by the same absolute deadline. */
export async function waitForPythonDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  timeoutMessage: string,
  now = Date.now(),
): Promise<T> {
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0) throw new Error(timeoutMessage);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
