import "server-only";
import type {
  ChatJobTerminalResponse,
  ChatStreamEvent,
  ChatUsage,
  SequencedChatStreamEvent,
} from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { recordUsage } from "../usage/usage-store";
import { claimChatJob, createChatJobEventWriter, finishChatJob, renewChatJob, type ChatJobClaim } from "./chat-job-store";
import { createChatEventCoalescer } from "./chat-event-coalescer";
import { CHAT_JOB_HEARTBEAT_MS } from "./chat-job-lease";
import type { ChatCitation, ChatSource } from "../../../lib/chat-citations";

export type RunChatJobOptions = {
  onEvent?: (event: SequencedChatStreamEvent) => void;
  /** Aborts provider work during graceful worker shutdown without cancelling the job. */
  shutdownSignal?: AbortSignal;
};

/**
 * The web process uses this as a small compatibility entrypoint for tests and
 * maintenance tools. Production execution passes an already-claimed job from
 * the PostgreSQL worker through runClaimedChatJob.
 */
export async function runChatJob(
  ownerId: string,
  conversationId: string,
  jobId: string,
  options: RunChatJobOptions = {},
): Promise<ChatJobTerminalResponse | null> {
  const claim = await claimChatJob(ownerId, conversationId, jobId);
  if (!claim) return null; // another route instance owns the active lease
  return runClaimedChatJob(ownerId, claim, options);
}

/** Execute one lease that was atomically claimed by the background worker. */
export async function runClaimedChatJob(
  ownerId: string,
  claim: ChatJobClaim,
  options: RunChatJobOptions = {},
): Promise<ChatJobTerminalResponse | null> {
  if (claim.status === "failed") {
    return {
      jobId: claim.jobId,
      status: "failed",
      error: claim.error ?? "The chat worker stopped before the job completed.",
      usage: null,
      finalOutput: "",
    };
  }
  const request = claim.request;
  if (!request) return null;
  const controller = new AbortController();
  const leaseToken = claim.leaseToken;
  const onShutdown = () => {
    controller.abort();
  };
  options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  let cancellationObserved = false;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = renewChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken)
      .then((state) => {
        if (state.cancelled) {
          cancellationObserved = true;
          controller.abort();
        } else if (!state.active) {
          controller.abort();
        }
      })
      .catch(() => {
        controller.abort();
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, CHAT_JOB_HEARTBEAT_MS);
  const eventWriter = createChatJobEventWriter(ownerId, claim.conversationId, claim.jobId, leaseToken);
  let output = "";
  let usage: ChatUsage | null = null;
  let generationError: string | null = null;
  let nextEventIndex = Math.max(1, claim.nextEventIndex);
  let completedProviderOutputWindowMs = 0;
  let roundFirstOutputAt: number | null = null;
  let roundLastOutputAt: number | null = null;
  let annotations: ChatCitation[] = [];
  let sources: ChatSource[] = [];
  const publishEvent = (event: ChatStreamEvent): void => {
    const sequence = nextEventIndex;
    nextEventIndex += 1;
    eventWriter.enqueue({ eventIndex: sequence, event });
    try {
      options.onEvent?.({ ...event, sequence, jobId: claim.jobId });
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
    if (event.type === "annotations") { annotations = event.annotations; sources = event.sources; }
    if (event.type === "done") usage = event.usage;
    if (event.type === "error") generationError = event.message;
  };
  const eventCoalescer = createChatEventCoalescer(publishEvent);
  const drainEventPipelines = async (): Promise<void> => {
    let firstError: unknown = null;
    try {
      await eventCoalescer.drain();
    } catch (error: unknown) {
      firstError = error;
    }
    try {
      await eventWriter.drain();
    } catch (error: unknown) {
      firstError ??= error;
    }
    if (firstError !== null) throw firstError;
  };
  const terminalResponse = (status: ChatJobTerminalResponse["status"], error: string | null): ChatJobTerminalResponse => {
    const completionTokens = usage?.completionTokens ?? null;
    const currentRoundWindowMs = roundFirstOutputAt === null || roundLastOutputAt === null
      ? 0
      : Math.max(0, roundLastOutputAt - roundFirstOutputAt);
    const outputWindowMs = completedProviderOutputWindowMs + currentRoundWindowMs || null;
    return {
      jobId: claim.jobId,
      status,
      error,
      usage,
      finalOutput: output,
      ...(annotations.length ? { annotations, sources } : {}),
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
      (event: ChatStreamEvent) => eventCoalescer.enqueue(event),
      async ({ round, usage: providerUsage, estimatedUsage, provider, model, exactCostUsd, pricing }) => {
        const recordedUsage = providerUsage ?? estimatedUsage;
        if (!recordedUsage) return;
        await recordUsage({
          ownerId,
          provider,
          model,
          requestKind: "chat",
          requestId: claim.jobId,
          round,
          usage: recordedUsage,
          source: providerUsage ? "exact" : "estimated",
          exactCostUsd,
          pricingSnapshot: pricing ? {
            provider,
            model,
            label: model,
            inputUsdPerMillion: pricing.inputUsdPerMillion ?? 0,
            cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion,
            outputUsdPerMillion: pricing.outputUsdPerMillion ?? 0,
          } : null,
          unpriced: exactCostUsd === undefined && (!pricing || pricing.inputUsdPerMillion === null || pricing.outputUsdPerMillion === null),
        });
      },
      async ({ provider, model, usage: summaryUsage, phase, revision, exactCostUsd }) => {
        if (!summaryUsage) return;
        await recordUsage({
          ownerId,
          provider,
          model,
          requestKind: "reasoning_summary",
          requestId: claim.jobId,
          round: phase * 100_000 + revision,
          usage: summaryUsage,
          source: "exact",
          exactCostUsd,
          unpriced: exactCostUsd === undefined,
          conversationId: claim.conversationId,
          jobId: claim.jobId,
        });
      },
    );
    await drainEventPipelines();
    if (!controller.signal.aborted) {
      const status = generationError ? "failed" : "completed";
      const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, status, { error: generationError, usage, finalOutput: output });
      return applied ? terminalResponse(status, generationError) : null;
    }
    return cancellationObserved ? terminalResponse("cancelled", null) : null;
  } catch (error) {
    await drainEventPipelines().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Generation failed.";
    if (controller.signal.aborted) {
      return cancellationObserved ? terminalResponse("cancelled", null) : null;
    }
    const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, "failed", { error: message, usage, finalOutput: output });
    return applied ? terminalResponse("failed", message) : null;
  } finally {
    await drainEventPipelines().catch(() => undefined);
    clearInterval(heartbeat);
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
