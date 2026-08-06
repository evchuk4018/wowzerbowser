import "server-only";

import { randomUUID } from "node:crypto";
import type { ChatStreamEvent } from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { getChatUserPreferences } from "../chat/chat-user-preferences-store";
import { recordUsage } from "../usage/usage-store";
import { formatBackgroundError } from "../observability/background-error";
import {
  finishAutomationRun,
  getAutomationRow,
  heartbeatAutomationRun,
  type ClaimedAutomationRun,
} from "./automation-repository";
import { nextFutureAutomationRun } from "./automation-schedule";
import type { AutomationRunResult } from "../agent/automation-run-result-tool";
import { queueDiscordAutomationDelivery } from "../discord/discord-automation-delivery-adapter";
import { chatAutomationDelivery, type AutomationDeliveryAdapter } from "./automation-delivery";
import { resolveAutomationAnswer } from "./automation-answer";

export type AutomationRunExecution = {
  outcome: "notified" | "no_match" | "failed" | "lease_lost";
};

export type AutomationRunnerDependencies = {
  getAutomation: typeof getAutomationRow;
  getPreferences: typeof getChatUserPreferences;
  generate: typeof generateChatResponse;
  recordUsage: typeof recordUsage;
  finish: typeof finishAutomationRun;
  heartbeat: typeof heartbeatAutomationRun;
  deliver: AutomationDeliveryAdapter;
  queueDiscord: typeof queueDiscordAutomationDelivery;
  now: () => Date;
  createSignal: () => AbortSignal;
};

const defaultDependencies: AutomationRunnerDependencies = {
  getAutomation: getAutomationRow,
  getPreferences: getChatUserPreferences,
  generate: generateChatResponse,
  recordUsage,
  finish: finishAutomationRun,
  heartbeat: heartbeatAutomationRun,
  deliver: chatAutomationDelivery,
  queueDiscord: queueDiscordAutomationDelivery,
  now: () => new Date(),
  createSignal: () => AbortSignal.timeout(240_000),
};

function mergeDependencies(overrides?: Partial<AutomationRunnerDependencies>): AutomationRunnerDependencies {
  return { ...defaultDependencies, ...overrides };
}

async function finish(
  run: ClaimedAutomationRun,
  dependencies: AutomationRunnerDependencies,
  input: Omit<Parameters<typeof finishAutomationRun>[1], "ownerId" | "leaseToken">,
): Promise<AutomationRunExecution> {
  const applied = await dependencies.finish(run.id, {
    ...input,
    ownerId: run.owner_id,
    leaseToken: run.lease_token,
  });
  return { outcome: applied ? input.outcome : "lease_lost" };
}

/** Execute one PostgreSQL-owned occurrence outside the web request lifecycle. */
export async function runClaimedAutomation(
  run: ClaimedAutomationRun,
  overrides?: Partial<AutomationRunnerDependencies>,
): Promise<AutomationRunExecution> {
  const dependencies = mergeDependencies(overrides);
  const automation = await dependencies.getAutomation(run.owner_id, run.automation_id);
  if (!automation || automation.status !== "active") {
    return finish(run, dependencies, {
      outcome: "failed",
      error: "Automation is no longer active.",
      nextRunAt: null,
      pause: true,
    });
  }

  let initialNextRunAt: string;
  try {
    initialNextRunAt = nextFutureAutomationRun(
      automation.schedule,
      automation.timeZone,
      new Date(run.scheduled_for),
      dependencies.now(),
    ).toISOString();
  } catch (error) {
    return finish(run, dependencies, {
      outcome: "failed",
      error: formatBackgroundError(error),
      nextRunAt: null,
      pause: true,
    });
  }
  const nextRunAt = (): string => nextFutureAutomationRun(
    automation.schedule,
    automation.timeZone,
    new Date(run.scheduled_for),
    dependencies.now(),
  ).toISOString();

  // A normal run is shorter than this lease, but refreshing it makes a
  // provider retry or a future longer model deadline recoverable without
  // allowing an expired worker to publish a duplicate outcome.
  const heartbeatTimer = setInterval(() => {
    void dependencies.heartbeat(run.owner_id, run.id, run.lease_token).catch(() => undefined);
  }, 60_000);

  try {
    const preferences = await dependencies.getPreferences(run.owner_id);
    const jobId = randomUUID();
    let content = "";
    let reasoning = "";
    let generationError = "";
    let structuredAnswer: AutomationRunResult | null = null;
    await dependencies.generate({
      systemPrompt: [
        "You are executing a recurring automation without a live user.",
        "Use available tools when current information is required.",
        "You must finish by calling complete_automation_run exactly once. Do not return the result as ordinary prose.",
        automation.kind === "report"
          ? "This is a report: matched must be true and message must contain the useful report."
          : "This is a live check: matched is true only when the stated condition is currently satisfied. When false, keep message to a short private evaluation note.",
        `Automation timezone: ${automation.timeZone}. Scheduled occurrence: ${run.scheduled_for}.`,
      ].join("\n"),
      userPresence: "",
      messages: [{ role: "user", content: automation.instructions }],
      model: preferences.automationModel!,
      thinking: Boolean(preferences.automationThinking),
      reasoningEffort: "medium",
      contextMode: "full",
      conversationId: `automation-${automation.id}`,
      jobId,
    }, run.owner_id, dependencies.createSignal(), async (event: ChatStreamEvent) => {
      if (event.type === "content") content += event.delta;
      if (event.type === "reasoning") reasoning += event.delta;
      if (event.type === "error") generationError = event.message;
    }, async ({ round, usage, estimatedUsage, provider, model, exactCostUsd, pricing }) => {
      const recordedUsage = usage ?? estimatedUsage;
      if (!recordedUsage) return;
      await dependencies.recordUsage({
        ownerId: run.owner_id, provider, model, requestKind: "automation", requestId: run.id, round,
        usage: recordedUsage, source: usage || exactCostUsd !== undefined ? "exact" : "estimated", exactCostUsd,
        pricingSnapshot: pricing ? { provider, model, label: model, inputUsdPerMillion: pricing.inputUsdPerMillion, cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion, outputUsdPerMillion: pricing.outputUsdPerMillion, requestUsd: pricing.requestUsd, reasoningUsdPerMillion: pricing.reasoningUsdPerMillion } : null,
        unpriced: exactCostUsd === undefined,
        conversationId: `automation-${automation.id}`,
        jobId,
      });
    }, undefined, { profile: "automation", onAutomationResult: (value) => { structuredAnswer = value; } });
    if (generationError) throw new Error(generationError);
    const answer = resolveAutomationAnswer(structuredAnswer, content, automation.name);
    const matched = automation.kind === "report" ? true : answer.matched;
    if (!matched) {
      return finish(run, dependencies, { outcome: "no_match", matched: false, title: answer.title, output: answer.message, nextRunAt: nextRunAt(), pause: false });
    }
    /*
      The old request dispatcher expressed this same durable branch as:
      if (!matched) { finish({ outcome: "no_match" }); return; }
      queueDiscordAutomationDelivery is reached only after a match.
    */
    // The default path is chatAutomationDelivery.deliver; tests and worker
    // deployments may inject a deterministic adapter at this boundary.
    const { conversationId } = await dependencies.deliver.deliver({
      ownerId: run.owner_id, runId: run.id, title: answer.title || automation.name, prompt: automation.instructions, message: answer.message,
      thinkingEnabled: preferences.automationThinking,
      ...(preferences.automationThinking && reasoning ? { reasoning } : {}),
    });
    if (conversationId) {
      await dependencies.queueDiscord({
        ownerId: run.owner_id,
        runId: run.id,
        conversationId,
        title: answer.title || automation.name,
        prompt: automation.instructions,
        message: answer.message,
      }).catch(() => {
        // Delivery failure is observable through the durable notification
        // state; the scheduler log deliberately excludes message content.
        console.error({ event: "discord-automation-enqueue-failed", automationRunId: run.id });
      });
    }
    return finish(run, dependencies, { outcome: "notified", matched: true, title: answer.title, output: answer.message, conversationId, nextRunAt: nextRunAt(), pause: automation.kind === "live_check" });
  } catch (error) {
    return finish(run, dependencies, {
      outcome: "failed",
      error: formatBackgroundError(error),
      nextRunAt: (() => {
        try { return nextRunAt(); } catch { return initialNextRunAt; }
      })(),
      pause: false,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}
