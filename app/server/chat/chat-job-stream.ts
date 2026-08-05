import type { ChatJobResumeResponse, ChatJobSubmissionResponse, ChatJobTerminalResponse } from "../../../lib/chat-protocol";
import { encodeChatLiveEnvelope } from "./encode-chat-live-envelope";
import { getChatJob } from "./chat-job-store";
import { subscribeToChatJobEvents } from "./chat-live-notifier";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LIVE_HEARTBEAT_MS = 15_000;

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Live delivery closed."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function terminalFor(snapshot: ChatJobResumeResponse): ChatJobTerminalResponse {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status as "completed" | "failed" | "cancelled",
    error: snapshot.error,
    usage: snapshot.usage,
    finalOutput: snapshot.finalOutput ?? "",
    ...(snapshot.annotations ? { annotations: snapshot.annotations } : {}),
    ...(snapshot.sources ? { sources: snapshot.sources } : {}),
  };
}

/** Stream durable PostgreSQL events; this process never claims or runs work. */
export function streamChatJob(
  ownerId: string,
  conversationId: string,
  submission: ChatJobSubmissionResponse,
  requestSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) controller.abort(requestSignal.reason);
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const send = (streamController: ReadableStreamDefaultController<Uint8Array>, value: Parameters<typeof encodeChatLiveEnvelope>[0]): boolean => {
    if (controller.signal.aborted) return false;
    try {
      streamController.enqueue(encodeChatLiveEnvelope(value));
      return true;
    } catch {
      controller.abort();
      return false;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      void (async () => {
        let after = 0;
        try {
          if (!send(streamController, { type: "submission", submission })) return;
          // Subscribe before querying so an event committed between the
          // snapshot and the wait cannot leave the stream asleep.
          const subscription = subscribeToChatJobEvents({ ownerId, conversationId, jobId: submission.jobId }, controller.signal);
          try {
            await subscription.ready;
            while (!controller.signal.aborted) {
              const snapshot = await getChatJob(ownerId, conversationId, submission.jobId, after);
              if (!snapshot) throw new Error("Chat job not found.");
              for (const event of snapshot.events) {
                if (event.sequence <= after) continue;
                if (!send(streamController, { type: "event", event })) return;
                after = event.sequence;
              }
              if (snapshot.hasMore) continue;
              if (TERMINAL_STATUSES.has(snapshot.status)) {
                send(streamController, { type: "terminal", terminal: terminalFor(snapshot) });
                return;
              }

              const timeoutController = new AbortController();
              const abortTimeout = () => timeoutController.abort(controller.signal.reason);
              controller.signal.addEventListener("abort", abortTimeout, { once: true });
              try {
                await Promise.race([
                  subscription.waitForNotification(timeoutController.signal),
                  waitFor(LIVE_HEARTBEAT_MS, timeoutController.signal),
                ]);
              } finally {
                controller.signal.removeEventListener("abort", abortTimeout);
                timeoutController.abort();
              }
            }
          } finally {
            await subscription.close();
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            try { streamController.error(error); } catch { /* client disconnected */ }
          }
        } finally {
          requestSignal.removeEventListener("abort", abortFromRequest);
          try { streamController.close(); } catch { /* already closed */ }
        }
      })();
    },
    cancel() {
      controller.abort();
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  }, { highWaterMark: 64 });
}
