import "server-only";

import type { DreamingAction, DreamingSource } from "../../../lib/user-memory";
import { consolidateUserMemoryWithQwen } from "../../providers/openrouter/openrouter-dreaming-adapter";
import { recordUsage } from "../usage/usage-store";
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
} from "./dreaming-repository";
import { buildDreamingPrompt } from "./dreaming-prompt";
import {
  createUserMemory,
  createUserMemoryFolder,
  deleteUserMemory,
  getUserMemoryTree,
  relocateUserMemory,
  updateUserMemory,
} from "./user-memory-service";

function enabled(): boolean {
  return !["0", "false", "no", "off"].includes(process.env.USER_MEMORY_DREAMING_ENABLED?.trim().toLowerCase() ?? "");
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

async function executeRun(ownerId: string, runId: string): Promise<boolean> {
  const run = await getDreamingRun(ownerId, runId);
  if (!run || run.status === "completed" || run.status === "failed") return false;
  const sources = await getDreamingSources(ownerId, runId);
  if (!sources) {
    if (await beginDreamingAttempt(ownerId, runId, run.attemptCount)) {
      await failDreamingRun(ownerId, runId, run.attemptCount + 1, "Source chat summaries are not ready.").catch(() => undefined);
    }
    return run.attemptCount + 1 >= 3;
  }
  if (!await beginDreamingAttempt(ownerId, runId, run.attemptCount)) return false;
  try {
    const tree = await getUserMemoryTree(ownerId);
    const answer = await consolidateUserMemoryWithQwen(buildDreamingPrompt(tree, sources));
    const actions = answer.actions.some((action) => action.action !== "noop")
      ? answer.actions.filter((action) => action.action !== "noop")
      : answer.actions.slice(0, 1);
    for (const [index, action] of actions.entries()) await applyAction(ownerId, runId, index, action, sources);
    const completedTree = await getUserMemoryTree(ownerId);
    await completeDreamingRun(ownerId, runId, completedTree.revision, answer.model, { actions });
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
    const message = error instanceof Error ? error.message : "Dreaming failed.";
    await failDreamingRun(ownerId, runId, run.attemptCount + 1, message).catch(() => undefined);
    console.warn({ event: "user-memory-dreaming-failed", runId, attempt: run.attemptCount + 1, error: message });
    return true;
  }
}

export async function processDreamingForCompletedJob(
  ownerId: string,
  conversationId: string,
  jobId: string,
): Promise<void> {
  if (!enabled()) return;
  await registerCompletedJobForDreaming(ownerId, conversationId, jobId);
  for (let processed = 0; processed < 8; processed += 1) {
    const runId = await claimDreamingRun(ownerId);
    if (!runId) return;
    const shouldContinue = await executeRun(ownerId, runId);
    if (!shouldContinue) return;
  }
}
