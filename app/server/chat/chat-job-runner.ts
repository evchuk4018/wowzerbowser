import "server-only";
import type {
  ChatJobTerminalResponse,
  ChatRunCost,
  ChatStreamEvent,
  ChatStreamMetrics,
  ChatUsage,
  SequencedChatStreamEvent,
} from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { recordPromptUsage, refreshPromptCost } from "../usage/prompt-cost-service";
import { claimChatJob, createChatJobEventWriter, finishChatJob, renewChatJob, saveChatJobResearchPlan, setChatJobAwaitingApproval, setChatJobAwaitingInput, type ChatJobClaim } from "./chat-job-store";
import { createChatEventCoalescer } from "./chat-event-coalescer";
import { CHAT_JOB_HEARTBEAT_MS } from "./chat-job-lease";
import type { ChatCitation, ChatSource } from "../../../lib/chat-citations";

export type RunChatJobOptions = {
  onEvent?: (event: SequencedChatStreamEvent) => void;
  /** Aborts provider work during graceful worker shutdown without cancelling the job. */
  shutdownSignal?: AbortSignal;
};

export type ChatHeartbeatState = {
  active: boolean;
  status?: string;
  cancelled?: boolean;
};

/**
 * Only an authoritative lease response may stop a running chat. A failed
 * heartbeat is transient until the database tells us otherwise.
 */
export function chatHeartbeatAction(state: ChatHeartbeatState): "continue" | "cancel" | "lease_lost" {
  if (state.cancelled) return "cancel";
  if (!state.active) return "lease_lost";
  return "continue";
}

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
        const action = chatHeartbeatAction(state);
        if (action === "cancel") {
          cancellationObserved = true;
          controller.abort();
        } else if (action === "lease_lost") {
          console.warn(JSON.stringify({
            event: "background-worker-chat-lease-lost",
            ownerId,
            conversationId: claim.conversationId,
            jobId: claim.jobId,
            status: state.status ?? "missing",
          }));
          controller.abort();
        }
      })
      .catch((error) => {
        // A transient PostgreSQL or pool error must not silently terminate a
        // chat. The next heartbeat will retry, while the lease remains the
        // authoritative safeguard if the worker cannot renew it.
        console.warn(JSON.stringify({
          event: "background-worker-chat-heartbeat-failed",
          ownerId,
          conversationId: claim.conversationId,
          jobId: claim.jobId,
          error: error instanceof Error ? error.message : "Unknown heartbeat error",
        }));
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, CHAT_JOB_HEARTBEAT_MS);
  const eventWriter = createChatJobEventWriter(ownerId, claim.conversationId, claim.jobId, leaseToken);
  let output = "";
  let usage: ChatUsage | null = null;
  let runCost: ChatRunCost | null = null;
  let generationError: string | null = null;
  let nextEventIndex = Math.max(1, claim.nextEventIndex);
  let completedProviderOutputWindowMs = 0;
  let roundFirstOutputAt: number | null = null;
  let roundLastOutputAt: number | null = null;
  let annotations: ChatCitation[] = [];
  let sources: ChatSource[] = [];
  let researchPlan: import("../../../lib/chat-protocol").DeepResearchPlan | null = null;
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
    if (event.type === "reasoning" || event.type === "content" || (event.type === "deep_research_orchestrator_update" && event.reasoningDelta)) {
      const now = performance.now();
      roundFirstOutputAt ??= now;
      roundLastOutputAt = now;
    }
    if (event.type === "content") output += event.delta;
    if (event.type === "annotations") { annotations = event.annotations; sources = event.sources; }
    if (event.type === "deep_research_plan") researchPlan = event.plan;
    if (event.type === "done") {
      usage = event.usage;
      runCost = event.runCost ?? runCost;
    }
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
  const responseMetrics = (): ChatStreamMetrics => {
    const completionTokens = usage?.completionTokens ?? null;
    const currentRoundWindowMs = roundFirstOutputAt === null || roundLastOutputAt === null
      ? 0
      : Math.max(0, roundLastOutputAt - roundFirstOutputAt);
    const outputWindowMs = completedProviderOutputWindowMs + currentRoundWindowMs || null;
    return {
      completionTokens,
      outputWindowMs,
      outputTps: completionTokens !== null && outputWindowMs !== null && outputWindowMs > 0
        ? completionTokens / (outputWindowMs / 1000)
        : null,
      ...(runCost ? { runCost } : {}),
    };
  };
  const terminalResponse = (status: ChatJobTerminalResponse["status"], error: string | null): ChatJobTerminalResponse => ({
    jobId: claim.jobId,
    status,
    error,
    usage,
    finalOutput: output,
    ...(annotations.length ? { annotations, sources } : {}),
    providerMetrics: responseMetrics(),
  });
  try {
    const generation = await generateChatResponse(
      request,
      ownerId,
      controller.signal,
      (event: ChatStreamEvent) => eventCoalescer.enqueue(event),
      async ({ round, usage: providerUsage, estimatedUsage, provider, model, exactCostUsd, pricing }) => {
        const recordedUsage = providerUsage ?? estimatedUsage;
        if (!recordedUsage) return;
        const refreshed = await recordPromptUsage({
          ownerId,
          provider,
          model,
          requestKind: "chat",
          requestId: claim.jobId,
          round,
          usage: recordedUsage,
          source: providerUsage || exactCostUsd !== undefined ? "exact" : "estimated",
          exactCostUsd,
          pricingSnapshot: pricing ? {
            provider,
            model,
            label: model,
            inputUsdPerMillion: pricing.inputUsdPerMillion,
            cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion,
            outputUsdPerMillion: pricing.outputUsdPerMillion,
            requestUsd: pricing.requestUsd,
            reasoningUsdPerMillion: pricing.reasoningUsdPerMillion,
          } : null,
          unpriced: exactCostUsd === undefined && (!pricing || pricing.inputUsdPerMillion === null || pricing.outputUsdPerMillion === null || ((providerUsage?.reasoningTokens ?? estimatedUsage?.reasoningTokens ?? 0) > 0 && pricing.reasoningUsdPerMillion === null)),
          conversationId: claim.conversationId,
          jobId: claim.jobId,
        });
        runCost = refreshed ?? runCost;
      },
      async ({ provider, model, usage: summaryUsage, estimatedUsage, phase, revision, exactCostUsd }) => {
        const recordedSummaryUsage = summaryUsage ?? estimatedUsage;
        if (!recordedSummaryUsage) return;
        const refreshed = await recordPromptUsage({
          ownerId,
          provider,
          model,
          requestKind: "reasoning_summary",
          requestId: claim.jobId,
          round: phase * 100_000 + revision,
          usage: recordedSummaryUsage,
          source: summaryUsage || exactCostUsd !== undefined ? "exact" : "estimated",
          exactCostUsd,
          unpriced: exactCostUsd === undefined,
          conversationId: claim.conversationId,
          jobId: claim.jobId,
        });
        runCost = refreshed ?? runCost;
      },
    );
    await drainEventPipelines();
    runCost = await refreshPromptCost(ownerId, claim.conversationId, claim.jobId) ?? runCost;
    if (!controller.signal.aborted && generation.awaitingApproval) {
      if (researchPlan) await saveChatJobResearchPlan(ownerId, claim.conversationId, claim.jobId, researchPlan);
      await setChatJobAwaitingApproval(ownerId, claim.conversationId, claim.jobId, leaseToken);
      return terminalResponse("awaiting_approval", null);
    }
    if (!controller.signal.aborted && generation.awaitingInput) {
      await setChatJobAwaitingInput(ownerId, claim.conversationId, claim.jobId, leaseToken);
      return terminalResponse("awaiting_input", null);
    }
    if (!controller.signal.aborted) {
      const status = generationError ? "failed" : "completed";
      const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, status, { error: generationError, usage, finalOutput: output, providerMetrics: responseMetrics() });
      return applied ? terminalResponse(status, generationError) : null;
    }
    return cancellationObserved ? terminalResponse("cancelled", null) : null;
  } catch (error) {
    await drainEventPipelines().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Generation failed.";
    if (controller.signal.aborted) {
      return cancellationObserved ? terminalResponse("cancelled", null) : null;
    }
    const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, "failed", { error: message, usage, finalOutput: output, providerMetrics: responseMetrics() });
    return applied ? terminalResponse("failed", message) : null;
  } finally {
    await drainEventPipelines().catch(() => undefined);
    clearInterval(heartbeat);
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
