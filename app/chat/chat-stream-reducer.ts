import type { SequencedChatStreamEvent } from "../../lib/chat-protocol";
import {
  applyChatStreamEvent,
  finalizeChatHistoryMessage,
} from "../../lib/chat-history";
import type { Message } from "./conversation-types";

export type ChatStreamReducerState = {
  message: Message;
  currentRound: number;
  waiting: boolean;
  streamError: boolean;
  thinkingFinished: boolean;
};

export type ChatStreamReducerOptions = {
  now?: number;
  thinkingStartedAt?: number | null;
};

export function createChatStreamState(
  message: Message,
  currentRound = 1,
): ChatStreamReducerState {
  return {
    message,
    currentRound,
    waiting: true,
    streamError: message.status === "error",
    thinkingFinished: message.thinkingDurationMs !== undefined,
  };
}

/**
 * Apply one durable stream event to an assistant message.
 *
 * This is intentionally data-only. The hook owns timers and dispatches the
 * returned message patch, while this reducer remains straightforward to test
 * with replayed event sequences.
 */
export function reduceChatStreamEvent(
  state: ChatStreamReducerState,
  event: SequencedChatStreamEvent,
  options: ChatStreamReducerOptions = {},
): ChatStreamReducerState {
  const now = options.now ?? Date.now();
  const base = applyChatStreamEvent(state.message, event, event.sequence, now);
  let message = base;
  let currentRound = state.currentRound;
  let waiting = state.waiting;
  let streamError = state.streamError;
  let thinkingFinished = state.thinkingFinished;

  switch (event.type) {
    case "round":
      currentRound = event.round;
      break;
    case "reasoning":
    case "phase_summary":
    case "phase_break":
    case "tool_call":
    case "content":
      waiting = false;
      break;
    case "tool_result":
    case "artifact":
    case "annotations":
      waiting = false;
      break;
    case "error":
      waiting = false;
      streamError = true;
      message = { ...message, status: "error", error: event.message };
      break;
    case "cancelled":
      waiting = false;
      message = { ...message, status: "cancelled" };
      break;
    case "done":
      waiting = false;
      message = finalizeChatHistoryMessage(
        { ...message, status: streamError ? "error" : "complete" },
        streamError ? "error" : "complete",
        {},
        now,
      );
      break;
    case "meta":
      break;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }

  if (
    options.thinkingStartedAt !== null &&
    options.thinkingStartedAt !== undefined &&
    !thinkingFinished &&
    event.type === "content"
  ) {
    thinkingFinished = true;
    message = {
      ...message,
      thinkingDurationMs: Math.max(0, now - options.thinkingStartedAt),
    };
  }

  return { message, currentRound, waiting, streamError, thinkingFinished };
}

export const chatStreamReducer = reduceChatStreamEvent;

export function reduceChatStreamEvents(
  state: ChatStreamReducerState,
  events: readonly SequencedChatStreamEvent[],
  options: ChatStreamReducerOptions = {},
): ChatStreamReducerState {
  return events.reduce(
    (current, event) => reduceChatStreamEvent(current, event, options),
    state,
  );
}
