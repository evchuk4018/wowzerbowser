import "server-only";

import type { DreamingAction, DreamingSource } from "../../../lib/user-memory";
import { consolidateUserMemoryWithQwen } from "../../providers/openrouter/openrouter-dreaming-adapter";
import { consolidateDreamingMemoryWithQwen } from "../../providers/openrouter/openrouter-dreaming-consolidation-adapter";
import { recordUsage } from "../usage/usage-store";
import { formatBackgroundError, logBackgroundTaskFailure } from "../observability/background-error";
import {
  claimDreamingRun,
  beginDreamingAttempt,
  completeDreamingRun,
  failDreamingRun,
  getDreamingRun,
  getDreamingSources,
  hasAppliedDreamingAction,
  markDreamingActionApplied,
  registerCompletedJobForDreaming,
  saveDreamingActionPlan,
  recordDreamingCycle,
  claimDreamingConsolidation,
  getDreamingConsolidationSources,
  getConsolidatedPrompt,
  completeDreamingConsolidation,
  failDreamingConsolidation,
  listCompletedChatJobsForMemory,
} from "./dreaming-repository";
import { processChatSummaryForCompletedJob } from "../chat/chat-summary-service";
import { buildDreamingConsolidationPrompt, buildDreamingPrompt } from "./dreaming-prompt";
import {
  createUserMemory,
  createUserMemoryFolder,
  deleteUserMemory,
  getUserMemoryTree,
  relocateUserMemory,
  updateUserMemory,
} from "./user-memory-service";

function dreamingEnabled(): boolean {
  return !["0", "false", "no", "off"].includes(process.env.USER_MEMORY_DREAMING_ENABLED?.trim().toLowerCase() ?? "");
}

function summaryEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(process.env.CHAT_DURABLE_SUMMARIES_ENABLED?.trim().toLowerCase() ?? "");
}

function enabled(): boolean {
  return dreamingEnabled();
}

function sourceFor(sources: DreamingSource[], chatId: string): DreamingSource {
  const source = sources.find((candidate) => candidate.chatId === chatId);
  if (!source) throw new Error("Dreaming action referenced an unsupported source chat.");
  return source;
}

async function applyAction(ownerId: string, runId: string, index: number, action: DreamingAction, sources: DreamingSource[]): Promise<void> {
  if (action.action === "noop" || await hasAppliedDreamingAction(runId, index)) return;
  const source = sourceFor(sources, action.sourceChatId);
  const context = {
    ownerId,
    sourceChatId: source.chatId,
    sourceJobId: source.jobId,
    writer: "dreaming" as const,
    dreamingRunId: runId,
    actionIndex: index * 100 + 99,
  };
  if (action.action === "create_folder") await createUserMemoryFolder(context, action.path);
  else if (action.action === "add") await createUserMemory(context, action.path, action.content);
  else if (action.action === "update") await updateUserMemory(context, action.memoryId, action.content);
  else if (action.action === "move") await relocateUserMemory(context, action.memoryId, action.path);
  else await deleteUserMemory(context, action.memoryId);
  await markDreamingActionApplied(runId, index);
}

async function executeRun(
  ownerId: string,
  runId: string,
  trigger: { conversationId: string; jobId: string },
): Promise<boolean> {
  const run = await getDreamingRun(ownerId, runId);
  if (!run || run.status === "completed" || run.status === "failed") return false;
  const sources = await getDreamingSources(ownerId, runId);
  if (!sources) {
    if (await beginDreamingAttempt(ownerId, runId, run.attemptCount)) {
      const error = new Error("Source chat summaries are not ready.");
      await failDreamingRun(ownerId, runId, run.attemptCount + 1, formatBackgroundError(error)).catch(() => undefined);
      logBackgroundTaskFailure("user-memory-dreaming-failed", {
        ownerId,
        runId,
        conversationId: trigger.conversationId,
        jobId: trigger.jobId,
        attempt: run.attemptCount + 1,
      }, error);
    }
    return run.attemptCount + 1 >= 3;
  }
  if (!await beginDreamingAttempt(ownerId, runId, run.attemptCount)) return false;
  try {
    const tree = await getUserMemoryTree(ownerId);
    const persistedActions = run.actionPlan?.actions ?? null;
    const answer = persistedActions
      ? { actions: persistedActions, model: run.model ?? "qwen/qwen3.7-flash", usage: null }
      : await consolidateUserMemoryWithQwen(buildDreamingPrompt(tree, sources));
    const actions = answer.actions.some((action) => action.action !== "noop")
      ? answer.actions.filter((action) => action.action !== "noop")
      : answer.actions.slice(0, 1);
    if (!persistedActions) await saveDreamingActionPlan(ownerId, runId, answer.model, { actions });
    for (const [index, action] of actions.entries()) await applyAction(ownerId, runId, index, action, sources);
    const completedTree = await getUserMemoryTree(ownerId);
    await completeDreamingRun(ownerId, runId, completedTree.revision, answer.model, { actions });
    const cycle = await recordDreamingCycle(ownerId, runId);
    if (cycle) await processDreamingConsolidation(ownerId, cycle).catch((error) => {
      logBackgroundTaskFailure("user-memory-consolidation-failed", { ownerId, cycle }, error);
    });
    if (answer.usage) {
      await recordUsage({
        ownerId,
        provider: "openrouter",
        model: answer.model,
        requestKind: "dreaming",
        requestId: runId,
        round: 0,
        usage: answer.usage,
        source: "exact",
        exactCostUsd: answer.exactCostUsd,
        unpriced: answer.exactCostUsd === undefined,
      }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    const attempt = run.attemptCount + 1;
    await failDreamingRun(ownerId, runId, attempt, formatBackgroundError(error)).catch(() => undefined);
    logBackgroundTaskFailure("user-memory-dreaming-failed", {
      ownerId,
      runId,
      conversationId: trigger.conversationId,
      jobId: trigger.jobId,
      attempt,
    }, error);
    return true;
  }
}

async function executeDreamingConsolidation(ownerId: string, job: NonNullable<Awaited<ReturnType<typeof claimDreamingConsolidation>>>): Promise<void> {
  try {
    const [tree, sources, previousSummary] = await Promise.all([
      getUserMemoryTree(ownerId),
      getDreamingConsolidationSources(ownerId, job.sourceRunIds),
      getConsolidatedPrompt(ownerId),
    ]);
    const answer = await consolidateDreamingMemoryWithQwen(buildDreamingConsolidationPrompt(tree, sources, previousSummary));
    const prompt = answer.summary.trim().slice(0, 8_000);
    await completeDreamingConsolidation(ownerId, job.cycleNumber, prompt, answer.model);
    if (answer.usage) await recordUsage({
      ownerId, provider: "openrouter", model: answer.model, requestKind: "dreaming", requestId: `consolidation-${job.cycleNumber}`,
      round: 0, usage: answer.usage, source: "exact", exactCostUsd: answer.exactCostUsd, unpriced: answer.exactCostUsd === undefined,
    }).catch(() => undefined);
  } catch (error) {
    await failDreamingConsolidation(ownerId, job.cycleNumber, formatBackgroundError(error)).catch(() => undefined);
    throw error;
  }
}

async function processDreamingConsolidation(ownerId: string, cycleNumber: number): Promise<void> {
  const job = await claimDreamingConsolidation(ownerId, cycleNumber);
  if (!job || job.cycleNumber !== cycleNumber) return;
  await executeDreamingConsolidation(ownerId, job);
}

async function processPendingDreamingConsolidation(ownerId: string): Promise<boolean> {
  const job = await claimDreamingConsolidation(ownerId);
  if (!job) return false;
  await executeDreamingConsolidation(ownerId, job);
  return true;
}

async function processDreamingRuns(
  ownerId: string,
  trigger: { conversationId: string; jobId: string },
  limit = 8,
): Promise<number> {
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const runId = await claimDreamingRun(ownerId);
    if (!runId) break;
    const shouldContinue = await executeRun(ownerId, runId, trigger);
    if (!shouldContinue) break;
  }
  return processed;
}

export async function processDreamingForCompletedJob(
  ownerId: string,
  conversationId: string,
  jobId: string,
): Promise<void> {
  if (!enabled()) return;
  await registerCompletedJobForDreaming(ownerId, conversationId, jobId);
  await processDreamingRuns(ownerId, { conversationId, jobId });
}

/**
 * Recover summaries, dreaming runs, and consolidation after a worker restart.
 * Every source and action is persisted before this sweep returns, so rerunning
 * the sweep is idempotent and never re-applies an action plan.
 */
export async function processScheduledMemoryWork(ownerId: string, limit = 8): Promise<{
  candidates: number;
  summaries: number;
  runs: number;
  consolidations: number;
}> {
  if (!dreamingEnabled() && !summaryEnabled()) return { candidates: 0, summaries: 0, runs: 0, consolidations: 0 };
  const candidates = await listCompletedChatJobsForMemory(ownerId, limit);
  let summaries = 0;
  for (const candidate of candidates) {
    try {
      await processChatSummaryForCompletedJob(ownerId, candidate.conversationId, candidate.jobId);
      summaries += 1;
    } catch (error) {
      logBackgroundTaskFailure("chat-summary-scheduler-failed", { task: "memory", recordId: candidate.jobId }, error);
    }
    if (dreamingEnabled()) {
      await registerCompletedJobForDreaming(ownerId, candidate.conversationId, candidate.jobId).catch((error) => {
        logBackgroundTaskFailure("user-memory-registration-failed", { task: "memory", recordId: candidate.jobId }, error);
      });
    }
  }
  const runs = dreamingEnabled()
    ? await processDreamingRuns(ownerId, { conversationId: "scheduler", jobId: "memory-scheduler" })
    : 0;
  let consolidations = 0;
  if (dreamingEnabled()) {
    try {
      consolidations = (await processPendingDreamingConsolidation(ownerId)) ? 1 : 0;
    } catch (error) {
      logBackgroundTaskFailure("user-memory-consolidation-scheduler-failed", { task: "memory" }, error);
    }
  }
  return { candidates: candidates.length, summaries, runs, consolidations };
}
