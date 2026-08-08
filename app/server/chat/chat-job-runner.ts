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
import { claimChatJob, createChatJobEventWriter, finishChatJob, renewChatJob, saveChatJobResearchPlan, setChatJobAwaitingApproval, type ChatJobClaim } from "./chat-job-store";
import { createChatEventCoalescer } from "./chat-event-coalescer";
import { CHAT_JOB_HEARTBEAT_MS } from "./chat-job-lease";
import type { ChatCitation, ChatSource } from "../../../lib/chat-citations";
import type { AbTestVariantKey } from "../../../lib/ab-test-protocol";
import { toolExecutionMetadata } from "../agent/tool-execution-policy";
import { persistAbTestVariantMessage } from "./chat-history-store";
import { deletePendingAbTestComparisonRow } from "../ab-testing/ab-test-repository";

type TaggedChatStreamEvent = ChatStreamEvent & { abVariant?: AbTestVariantKey };

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
  let runCost: ChatRunCost | null = null;
  let generationError: string | null = null;
  const abTestExecution = request.abTest;
  const variantOutputs: Record<AbTestVariantKey, string> = { a: "", b: "" };
  const variantUsages: Partial<Record<AbTestVariantKey, ChatUsage | null>> = {};
  const variantErrors: Partial<Record<AbTestVariantKey, string>> = {};
  const variantControllers: Partial<Record<AbTestVariantKey, AbortController>> = {};
  let activeVariant: AbTestVariantKey | null = null;
  let unsafeToolDetected = false;
  let nextEventIndex = Math.max(1, claim.nextEventIndex);
  let completedProviderOutputWindowMs = 0;
  let roundFirstOutputAt: number | null = null;
  let roundLastOutputAt: number | null = null;
  let annotations: ChatCitation[] = [];
  let sources: ChatSource[] = [];
  let researchPlan: import("../../../lib/chat-protocol").DeepResearchPlan | null = null;
  const publishEvent = (event: TaggedChatStreamEvent): void => {
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
    const eventVariant = event.abVariant;
    if (event.type === "content") {
      if (eventVariant) variantOutputs[eventVariant] += event.delta;
      else output += event.delta;
    }
    if (event.type === "annotations") { annotations = event.annotations; sources = event.sources; }
    if (event.type === "deep_research_plan") researchPlan = event.plan;
    if (event.type === "done") {
      if (eventVariant) variantUsages[eventVariant] = event.usage;
      else usage = event.usage;
      runCost = event.runCost ?? runCost;
    }
    if (event.type === "error") {
      if (eventVariant) variantErrors[eventVariant] = event.message;
      else generationError = event.message;
    }
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
    const pairedCompletionTokens = Object.values(variantUsages).reduce(
      (total, current) => total + (current?.completionTokens ?? 0),
      0,
    );
    const completionTokens = abTestExecution
      ? (pairedCompletionTokens || null)
      : (usage?.completionTokens ?? null);
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
  const persistGenerationEvent = async (event: ChatStreamEvent): Promise<void> => {
    if (!activeVariant) {
      await eventCoalescer.enqueue(event);
      return;
    }
    const taggedEvent = { ...event, abVariant: activeVariant } as TaggedChatStreamEvent;
    if (event.type === "tool_call" && !event.call.name.startsWith("connector__") && toolExecutionMetadata(event.call.name).executionPolicy !== "parallel-safe") {
      unsafeToolDetected = true;
      variantControllers[activeVariant]?.abort(new Error("This turn uses a side-effecting tool and cannot be A/B tested."));
    }
    // The shared coalescer intentionally stays out of paired execution: it
    // cannot merge adjacent deltas from different variants without losing the
    // variant tag.
    publishEvent(taggedEvent);
  };
  try {
    const runGeneration = async (variant: AbTestVariantKey | null, variantRequest: typeof request): Promise<{ awaitingApproval: boolean }> => {
      activeVariant = variant;
      const variantController = new AbortController();
      variantControllers[variant ?? "a"] = variantController;
      const abortVariant = () => variantController.abort(controller.signal.reason);
      if (controller.signal.aborted) variantController.abort(controller.signal.reason);
      else controller.signal.addEventListener("abort", abortVariant, { once: true });
      try {
        return await generateChatResponse(
          variantRequest,
          ownerId,
          variantController.signal,
          persistGenerationEvent,
          async ({ round, usage: providerUsage, estimatedUsage, provider, model, exactCostUsd, pricing }) => {
        const recordedUsage = providerUsage ?? estimatedUsage;
        if (!recordedUsage) return;
        const refreshed = await recordPromptUsage({
          ownerId,
          provider,
          model,
          requestKind: "chat",
          requestId: variant ? `${claim.jobId}:${variant}` : claim.jobId,
          round: variant ? round * 2 + (variant === "b" ? 1 : 0) : round,
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
          requestId: variant ? `${claim.jobId}:${variant}` : claim.jobId,
          round: phase * 100_000 + revision + (variant === "b" ? 1 : 0),
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Generation failed.";
        if (variant) variantErrors[variant] ??= message;
        else generationError ??= message;
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", abortVariant);
        activeVariant = null;
      }
    };
    const generation = abTestExecution
      ? await (async () => {
          const first = await runGeneration("a", {
            ...request,
            model: abTestExecution.variantA.snapshot.model,
            thinking: abTestExecution.variantA.snapshot.thinking,
            reasoningEffort: abTestExecution.variantA.snapshot.reasoningEffort,
            systemPrompt: abTestExecution.variantA.snapshot.systemPrompt,
            userPresence: abTestExecution.variantA.snapshot.userPresence,
            contextMode: abTestExecution.variantA.snapshot.contextMode,
            mode: abTestExecution.variantA.snapshot.mode,
          });
          if (!controller.signal.aborted && !unsafeToolDetected) {
            await runGeneration("b", {
              ...request,
              model: abTestExecution.variantB.snapshot.model,
              thinking: abTestExecution.variantB.snapshot.thinking,
              reasoningEffort: abTestExecution.variantB.snapshot.reasoningEffort,
              systemPrompt: abTestExecution.variantB.snapshot.systemPrompt,
              userPresence: abTestExecution.variantB.snapshot.userPresence,
              contextMode: abTestExecution.variantB.snapshot.contextMode,
              mode: abTestExecution.variantB.snapshot.mode,
            });
          }
          return first;
        })()
      : await runGeneration(null, request);
    await drainEventPipelines();
    runCost = await refreshPromptCost(ownerId, claim.conversationId, claim.jobId) ?? runCost;
    if (abTestExecution && !controller.signal.aborted && (variantErrors.a || variantErrors.b || unsafeToolDetected)) {
      await deletePendingAbTestComparisonRow(ownerId, abTestExecution.trialId, abTestExecution.comparisonId).catch(() => undefined);
      output = variantOutputs.a;
      usage = variantUsages.a ?? null;
      generationError = variantErrors.a ?? null;
    } else if (abTestExecution && !controller.signal.aborted && !unsafeToolDetected) {
      await persistAbTestVariantMessage({
        ownerId,
        conversationId: claim.conversationId,
        turnId: abTestExecution.turnId,
        canonicalVersionId: request.persistence?.versionId ?? "",
        versionId: abTestExecution.variantB.persistence.versionId,
        responseId: abTestExecution.variantB.persistence.assistantMessageId,
        userMessageId: abTestExecution.variantB.persistence.userMessageId,
        jobId: claim.jobId,
        variant: "b",
        thinking: abTestExecution.variantB.snapshot.thinking,
        finalOutput: variantOutputs.b,
        status: variantErrors.b ? "error" : "complete",
        error: variantErrors.b ?? null,
      });
      output = variantOutputs.a;
      usage = variantUsages.a ?? null;
      generationError = variantErrors.a ?? variantErrors.b ?? null;
    }
    if (!controller.signal.aborted && generation.awaitingApproval) {
      if (researchPlan) await saveChatJobResearchPlan(ownerId, claim.conversationId, claim.jobId, researchPlan);
      await setChatJobAwaitingApproval(ownerId, claim.conversationId, claim.jobId, leaseToken);
      return terminalResponse("awaiting_approval", null);
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
    if (abTestExecution) {
      await deletePendingAbTestComparisonRow(ownerId, abTestExecution.trialId, abTestExecution.comparisonId).catch(() => undefined);
      output = variantOutputs.a;
      usage = variantUsages.a ?? null;
      generationError = variantErrors.a ?? (!variantOutputs.a && !variantUsages.a ? message : null);
      const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, generationError ? "failed" : "completed", {
        error: generationError,
        usage,
        finalOutput: output,
        providerMetrics: responseMetrics(),
      });
      return applied ? terminalResponse(generationError ? "failed" : "completed", generationError) : null;
    }
    const applied = await finishChatJob(ownerId, claim.conversationId, claim.jobId, leaseToken, "failed", { error: message, usage, finalOutput: output, providerMetrics: responseMetrics() });
    return applied ? terminalResponse("failed", message) : null;
  } finally {
    await drainEventPipelines().catch(() => undefined);
    if (abTestExecution && controller.signal.aborted) {
      await deletePendingAbTestComparisonRow(ownerId, abTestExecution.trialId, abTestExecution.comparisonId).catch(() => undefined);
    }
    clearInterval(heartbeat);
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
