import "server-only";

import {
  claimDueAutomationRuns,
  type ClaimedAutomationRun,
} from "./automation-repository";
import {
  runClaimedAutomation,
  type AutomationRunExecution,
  type AutomationRunnerDependencies,
} from "./automation-runner";

export type AutomationSchedulerTick = {
  claimed: number;
  completed: number;
  failed: number;
  leaseLost: number;
  runs: Array<{ id: string; outcome: AutomationRunExecution["outcome"]; durationMs: number }>;
};

export type AutomationSchedulerDependencies = {
  claim: (limit: number) => Promise<ClaimedAutomationRun[]>;
  execute: (run: ClaimedAutomationRun) => Promise<AutomationRunExecution>;
  batchSize?: number;
  now?: () => number;
};

/** A bounded, provider-agnostic tick used by the worker and deterministic tests. */
export async function runAutomationSchedulerTick(
  dependencies: AutomationSchedulerDependencies,
): Promise<AutomationSchedulerTick> {
  const batchSize = Math.max(1, Math.min(dependencies.batchSize ?? 1, 4));
  const now = dependencies.now ?? Date.now;
  const runs = await dependencies.claim(batchSize);
  const settled = await Promise.allSettled(runs.map(async (run) => ({
    id: run.id,
    startedAt: now(),
    execution: await dependencies.execute(run),
    durationMs: now(),
  })));
  const outcomes = settled.map((result, index) => result.status === "fulfilled"
    ? { id: result.value.id, outcome: result.value.execution.outcome, durationMs: result.value.durationMs - result.value.startedAt }
    : { id: runs[index].id, outcome: "failed" as const, durationMs: 0 });
  return {
    claimed: runs.length,
    completed: outcomes.filter(({ outcome }) => outcome === "notified" || outcome === "no_match").length,
    failed: outcomes.filter(({ outcome }) => outcome === "failed").length,
    leaseLost: outcomes.filter(({ outcome }) => outcome === "lease_lost").length,
    runs: outcomes,
  };
}

export async function runAutomationSchedulerTickForOwner(
  ownerId: string,
  options: { batchSize?: number; leaseMs?: number; runner?: Partial<AutomationRunnerDependencies> } = {},
): Promise<AutomationSchedulerTick> {
  return runAutomationSchedulerTick({
    batchSize: options.batchSize,
    claim: (limit) => claimDueAutomationRuns(ownerId, limit, options.leaseMs),
    execute: (run) => runClaimedAutomation(run, options.runner),
  });
}
