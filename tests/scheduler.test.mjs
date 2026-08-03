import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundWorkerLoop } from "../app/server/worker/worker-loop.ts";
import { runAutomationSchedulerTick } from "../app/server/automations/automation-scheduler.ts";
import { nextFutureAutomationRun } from "../app/server/automations/automation-schedule.ts";
import { runClaimedAutomation } from "../app/server/automations/automation-runner.ts";

const run = {
  id: "run-1",
  owner_id: "owner-1",
  automation_id: "automation-1",
  scheduled_for: "2026-08-01T00:00:00.000Z",
  lease_token: "11111111-1111-4111-8111-111111111111",
  attempt_count: 1,
};

test("simultaneous scheduler ticks execute one due automation exactly once", async () => {
  let claimed = false;
  let executions = 0;
  const tick = () => runAutomationSchedulerTick({
    claim: async () => {
      await Promise.resolve();
      if (claimed) return [];
      claimed = true;
      return [run];
    },
    execute: async () => {
      executions += 1;
      return { outcome: "notified" };
    },
    now: () => 100,
  });

  const ticks = await Promise.all([tick(), tick()]);
  assert.equal(ticks.reduce((total, value) => total + value.claimed, 0), 1);
  assert.equal(executions, 1);
});

test("overdue interval work runs once and advances to the first future occurrence", () => {
  assert.equal(
    nextFutureAutomationRun(
      { kind: "interval", everyMinutes: 15 },
      "Etc/UTC",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T01:01:00.000Z"),
    ).toISOString(),
    "2026-08-01T01:15:00.000Z",
  );
});

test("paused or deleted automations finish without invoking a provider", async () => {
  const finished = [];
  let generated = 0;
  const dependencies = {
    getPreferences: async () => ({ automationModel: { provider: "openrouter", model: "test" }, automationThinking: false }),
    generate: async () => { generated += 1; },
    recordUsage: async () => undefined,
    heartbeat: async () => true,
    finish: async (_id, input) => { finished.push(input); return true; },
    deliver: { deliver: async () => ({}) },
    queueDiscord: async () => undefined,
    createSignal: () => new AbortController().signal,
    now: () => new Date("2026-08-01T00:01:00.000Z"),
  };

  await runClaimedAutomation(run, { ...dependencies, getAutomation: async () => ({ ...automation(), status: "paused" }) });
  await runClaimedAutomation({ ...run, id: "run-deleted" }, { ...dependencies, getAutomation: async () => null });
  assert.equal(generated, 0);
  assert.equal(finished.length, 2);
  assert.equal(finished.every((input) => input.pause && input.outcome === "failed"), true);
});

test("failed automation attempts are persisted by the runner and can trigger automatic pause", async () => {
  let failures = 0;
  let status = "active";
  const dependencies = {
    getAutomation: async () => ({ ...automation(), status }),
    getPreferences: async () => ({ automationModel: { provider: "openrouter", model: "test" }, automationThinking: false }),
    generate: async () => { throw new Error("provider unavailable"); },
    recordUsage: async () => undefined,
    heartbeat: async () => true,
    finish: async (_id, input) => {
      assert.equal(input.outcome, "failed");
      failures += 1;
      if (failures >= 3) status = "paused";
      return true;
    },
    deliver: { deliver: async () => ({}) },
    queueDiscord: async () => undefined,
    createSignal: () => new AbortController().signal,
    now: () => new Date("2026-08-01T00:01:00.000Z"),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runClaimedAutomation({ ...run, id: `run-failure-${attempt}` }, dependencies);
  }
  assert.equal(failures, 3);
  assert.equal(status, "paused");
});

test("one scheduler loop failure does not stop chat processing or another loop", async () => {
  let chatRuns = 0;
  let healthySchedulerRuns = 0;
  let schedulerFailure = 0;
  const loop = new BackgroundWorkerLoop({
    pollIntervalMs: 1,
    claimChat: async () => chatRuns++ === 0 ? { jobId: "chat-1" } : null,
    claimDocument: async () => null,
    claimImage: async () => null,
    executeChat: async () => undefined,
    executeDocument: async () => undefined,
    executeImage: async () => undefined,
    schedulerTasks: [
      { name: "broken", intervalMs: 1_000, run: async () => { throw new Error("broken loop"); } },
      { name: "healthy", intervalMs: 1_000, run: async () => { healthySchedulerRuns += 1; } },
    ],
    onTaskError: (kind) => { if (kind === "scheduler") schedulerFailure += 1; },
  });
  const running = loop.run();
  for (let attempt = 0; attempt < 50 && (!chatRuns || !healthySchedulerRuns || !schedulerFailure); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  loop.requestShutdown();
  await running;
  assert.equal(chatRuns > 0, true);
  assert.equal(healthySchedulerRuns > 0, true);
  assert.equal(schedulerFailure > 0, true);
});

function automation() {
  return {
    id: "automation-1",
    name: "Test automation",
    kind: "report",
    instructions: "Return a deterministic report.",
    schedule: { kind: "interval", everyMinutes: 15 },
    timeZone: "Etc/UTC",
    status: "active",
    nextRunAt: "2026-08-01T00:15:00.000Z",
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
