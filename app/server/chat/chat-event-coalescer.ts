import type { ChatStreamEvent } from "../../../lib/chat-protocol";

export type ChatEventCoalescerOptions = {
  /** Delay used to collect adjacent text deltas before publishing them. */
  flushIntervalMs?: number;
  /** Maximum text length in one published event. */
  maxTextLength?: number;
};

export type ChatEventCoalescer = {
  /** Queue one stream event, publishing structural events in order. */
  enqueue(event: ChatStreamEvent): Promise<void>;
  /** Flush the final text group and every already-published event. */
  drain(): Promise<void>;
};

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_TEXT_LENGTH = 4_096;

type CoalescibleEvent = Extract<ChatStreamEvent, { type: "content" | "reasoning" | "deep_research_orchestrator_update" }>;

function isCoalescible(event: ChatStreamEvent): event is CoalescibleEvent {
  if (event.type === "content" || event.type === "reasoning") return Boolean(event.delta);
  return event.type === "deep_research_orchestrator_update" && Boolean(event.reasoningDelta);
}

function deltaOf(event: CoalescibleEvent): string {
  return event.type === "deep_research_orchestrator_update" ? event.reasoningDelta ?? "" : event.delta;
}

function withDelta(event: CoalescibleEvent, delta: string): CoalescibleEvent {
  return event.type === "deep_research_orchestrator_update"
    ? { ...event, reasoningDelta: delta }
    : { ...event, delta };
}

/**
 * Coalesce adjacent provider text deltas without changing the event order
 * visible to the live stream or durable replay. The publisher owns sequence
 * assignment, so one published group always receives one contiguous ordinal.
 */
export function createChatEventCoalescer(
  publish: (event: ChatStreamEvent) => Promise<void> | void,
  options: ChatEventCoalescerOptions = {},
): ChatEventCoalescer {
  const flushIntervalMs = Math.max(0, Math.floor(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));
  const maxTextLength = Math.max(1, Math.floor(options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH));
  let pending: CoalescibleEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let publishTail = Promise.resolve();
  let failure: unknown = null;

  const rememberFailure = (error: unknown): void => {
    failure ??= error;
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const publishInOrder = (event: ChatStreamEvent): Promise<void> => {
    if (failure !== null) return Promise.reject(failure);
    const next = publishTail.then(async () => {
      if (failure !== null) throw failure;
      await publish(event);
    });
    publishTail = next.then(
      () => undefined,
      (error: unknown) => { rememberFailure(error); },
    );
    return next;
  };

  const flush = (): Promise<void> => {
    if (!pending) return Promise.resolve();
    const event = pending;
    pending = null;
    return publishInOrder(event);
  };

  const schedule = (): void => {
    if (timer !== null || !pending) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(rememberFailure);
    }, flushIntervalMs);
  };

  return {
    async enqueue(event): Promise<void> {
      if (failure !== null) throw failure;

      if (!isCoalescible(event)) {
        clearTimer();
        await flush();
        await publishInOrder(event);
        return;
      }

      if (pending && pending.type !== event.type) {
        clearTimer();
        await flush();
      }

      if (pending) pending = withDelta(pending, `${deltaOf(pending)}${deltaOf(event)}`);
      else pending = withDelta(event, deltaOf(event));

      if (deltaOf(pending).length >= maxTextLength) {
        clearTimer();
        await flush();
      } else {
        schedule();
      }
    },

    async drain(): Promise<void> {
      clearTimer();
      try {
        await flush();
        await publishTail;
      } catch (error: unknown) {
        rememberFailure(error);
        throw failure;
      }
      if (failure !== null) throw failure;
    },
  };
}
