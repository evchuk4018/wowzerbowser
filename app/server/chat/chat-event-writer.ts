export type AsyncBatchWriter<T> = {
  /** Queue one value without waiting for the persistence operation. */
  enqueue(value: T): void;
  /** Flush all queued and in-flight values, surfacing persistence failures. */
  drain(): Promise<void>;
};

export type AsyncBatchWriterOptions = {
  batchSize?: number;
  flushIntervalMs?: number;
};

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_FLUSH_INTERVAL_MS = 100;

/**
 * Serialize asynchronous batch writes while keeping producers off the write
 * path. A failed write is retained and surfaced to subsequent enqueues/drain
 * calls so callers cannot accidentally report a durable job as successful.
 */
export function createAsyncBatchWriter<T>(
  persistBatch: (values: readonly T[]) => Promise<void>,
  options: AsyncBatchWriterOptions = {},
): AsyncBatchWriter<T> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const flushIntervalMs = Math.max(0, Math.floor(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));
  const pending: T[] = [];
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failure: unknown = null;
  let failed = false;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const rememberFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failure = error;
  };

  const flush = (): Promise<void> => {
    if (failed) return Promise.reject(failure);
    if (inFlight) return inFlight;
    if (!pending.length) return Promise.resolve();

    const batch = pending.splice(0, batchSize);
    inFlight = persistBatch(batch)
      .catch((error: unknown) => {
        rememberFailure(error);
        throw error;
      })
      .finally(() => {
        inFlight = null;
        if (!failed && pending.length) {
          if (pending.length >= batchSize) {
            void flush().catch(rememberFailure);
          } else if (timer === null) {
            timer = setTimeout(() => {
              timer = null;
              void flush().catch(rememberFailure);
            }, flushIntervalMs);
          }
        }
      });
    return inFlight;
  };

  const schedule = () => {
    if (timer !== null || inFlight !== null || !pending.length) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(rememberFailure);
    }, flushIntervalMs);
  };

  return {
    enqueue(value: T): void {
      if (failed) throw failure;
      pending.push(value);
      if (pending.length >= batchSize) {
        clearTimer();
        void flush().catch(rememberFailure);
      } else {
        schedule();
      }
    },

    async drain(): Promise<void> {
      clearTimer();
      while (pending.length || inFlight) {
        if (inFlight) {
          await inFlight;
        } else {
          await flush();
        }
      }
      if (failed) throw failure;
    },
  };
}
