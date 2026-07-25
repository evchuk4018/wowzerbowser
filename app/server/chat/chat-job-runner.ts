import "server-only";
import type {
  ChatJobTerminalResponse,
  ChatStreamEvent,
  ChatUsage,
  SequencedChatStreamEvent,
} from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { recordUsage } from "../usage/usage-store";
import { claimChatJob, createChatJobEventWriter, finishChatJob, isChatJobCancelled } from "./chat-job-store";

export type RunChatJobOptions = {
  onEvent?: (event: SequencedChatStreamEvent) => void;
};

/** Runs from Next's server-owned `after` lifecycle, never from the request signal. */
export async function runChatJob(
  ownerId: string,
  conversationId: string,
  jobId: string,
  options: RunChatJobOptions = {},
): Promise<ChatJobTerminalResponse | null> {
  const request = await claimChatJob(ownerId, conversationId, jobId);
  if (!request) return null; // another route instance already claimed this idempotent job
  const controller = new AbortController();
  const poll = setInterval(() => void isChatJobCancelled(ownerId, conversationId, jobId).then((cancelled) => cancelled && controller.abort()), 750);
  const eventWriter = createChatJobEventWriter(ownerId, conversationId, jobId);
  let output = "";
  let usage: ChatUsage | null = null;
  let generationError: string | null = null;
  let nextEventIndex = 1;
  let completedProviderOutputWindowMs = 0;
  let roundFirstOutputAt: number | null = null;
  let roundLastOutputAt: number | null = null;
  const terminalResponse = (status: ChatJobTerminalResponse["status"], error: string | null): ChatJobTerminalResponse => {
    const completionTokens = usage?.completionTokens ?? null;
    const currentRoundWindowMs = roundFirstOutputAt === null || roundLastOutputAt === null
      ? 0
      : Math.max(0, roundLastOutputAt - roundFirstOutputAt);
    const outputWindowMs = completedProviderOutputWindowMs + currentRoundWindowMs || null;
    return {
      jobId,
      status,
      error,
      usage,
      finalOutput: output,
      providerMetrics: {
        completionTokens,
        outputWindowMs,
        outputTps: completionTokens !== null && outputWindowMs !== null && outputWindowMs > 0
          ? completionTokens / (outputWindowMs / 1000)
          : null,
      },
    };
  };
  try {
    await generateChatResponse(
      request,
      ownerId,
      controller.signal,
      async (event: ChatStreamEvent) => {
        const sequence = nextEventIndex;
        nextEventIndex += 1;
        eventWriter.enqueue({ eventIndex: sequence, event });
        try {
          options.onEvent?.({ ...event, sequence, jobId });
        } catch {
          // Live delivery is best effort. Durable execution must survive a
          // closed or failed response stream.
        }
        if (event.type === "round") {
          if (roundFirstOutputAt !== null && roundLastOutputAt !== null) {
            completedProviderOutputWindowMs += Math.max(0, roundLastOutputAt - roundFirstOutputAt);
          }
          roundFirstOutputAt = null;
          roundLastOutputAt = null;
        }
        if (event.type === "reasoning" || event.type === "content") {
          const now = performance.now();
          roundFirstOutputAt ??= now;
          roundLastOutputAt = now;
        }
        if (event.type === "content") output += event.delta;
        if (event.type === "done") usage = event.usage;
        if (event.type === "error") generationError = event.message;
      },
      async ({ round, usage: providerUsage, estimatedUsage }) => {
        await recordUsage({
          ownerId,
          provider: "deepseek",
          model: request.model,
          requestKind: "chat",
          requestId: jobId,
          round,
          usage: providerUsage ?? estimatedUsage,
          source: providerUsage ? "exact" : "estimated",
        });
      },
    );
    await eventWriter.drain();
    if (!controller.signal.aborted) {
      const status = generationError ? "failed" : "completed";
      await finishChatJob(ownerId, conversationId, jobId, status, { error: generationError, usage, finalOutput: output });
      return terminalResponse(status, generationError);
    }
    return terminalResponse("cancelled", null);
  } catch (error) {
    await eventWriter.drain().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Generation failed.";
    if (!controller.signal.aborted) {
      await finishChatJob(ownerId, conversationId, jobId, "failed", { error: message, usage, finalOutput: output });
      return terminalResponse("failed", message);
    }
    return terminalResponse("cancelled", null);
  } finally {
    await eventWriter.drain().catch(() => undefined);
    clearInterval(poll);
  }
}
