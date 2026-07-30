import "server-only";
import { randomUUID } from "node:crypto";
import type { ChatStreamEvent } from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { getChatUserPreferences } from "../chat/chat-user-preferences-store";
import { recordUsage } from "../usage/usage-store";
import { getAutomationRow, finishAutomationRun } from "./automation-repository";
import { nextAutomationRun } from "./automation-schedule";
import type { AutomationRunResult } from "../agent/automation-run-result-tool";
import { queueDiscordAutomationDelivery } from "../discord/discord-automation-delivery-adapter";
import { chatAutomationDelivery } from "./automation-delivery";
import { resolveAutomationAnswer } from "./automation-answer";

type ClaimedRun = { id: string; owner_id: string; automation_id: string; scheduled_for: string };

export async function runClaimedAutomation(run: ClaimedRun): Promise<void> {
  const automation = await getAutomationRow(run.owner_id, run.automation_id);
  if (!automation || automation.status !== "active") {
    await finishAutomationRun(run.id, { outcome: "failed", error: "Automation is no longer active.", nextRunAt: null, pause: true });
    return;
  }
  const nextRunAt = nextAutomationRun(automation.schedule, automation.timeZone, new Date(run.scheduled_for)).toISOString();
  try {
    const preferences = await getChatUserPreferences(run.owner_id);
    const jobId = randomUUID();
    let content = "";
    let reasoning = "";
    let generationError = "";
    let structuredAnswer: AutomationRunResult | null = null;
    await generateChatResponse({
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
    }, run.owner_id, AbortSignal.timeout(240_000), async (event: ChatStreamEvent) => {
      if (event.type === "content") content += event.delta;
      if (event.type === "reasoning") reasoning += event.delta;
      if (event.type === "error") generationError = event.message;
    }, async ({ round, usage, estimatedUsage, provider, model, exactCostUsd, pricing }) => {
      await recordUsage({
        ownerId: run.owner_id, provider, model, requestKind: "automation", requestId: run.id, round,
        usage: usage ?? estimatedUsage, source: usage ? "exact" : "estimated", exactCostUsd,
        pricingSnapshot: pricing ? { provider, model, label: model, inputUsdPerMillion: pricing.inputUsdPerMillion ?? 0, cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion, outputUsdPerMillion: pricing.outputUsdPerMillion ?? 0 } : null,
        unpriced: exactCostUsd === undefined,
      });
    }, undefined, { profile: "automation", onAutomationResult: (value) => { structuredAnswer = value; } });
    if (generationError) throw new Error(generationError);
    const answer = resolveAutomationAnswer(structuredAnswer, content, automation.name);
    const matched = automation.kind === "report" ? true : answer.matched;
    if (!matched) {
      await finishAutomationRun(run.id, { outcome: "no_match", matched: false, title: answer.title, output: answer.message, nextRunAt, pause: false });
      return;
    }
    const { conversationId } = await chatAutomationDelivery.deliver({
      ownerId: run.owner_id, runId: run.id, title: answer.title || automation.name, prompt: automation.instructions, message: answer.message,
      thinkingEnabled: preferences.automationThinking,
      ...(preferences.automationThinking && reasoning ? { reasoning } : {}),
    });
    if (conversationId) {
      await queueDiscordAutomationDelivery({
        ownerId: run.owner_id,
        runId: run.id,
        conversationId,
        title: answer.title || automation.name,
        prompt: automation.instructions,
        message: answer.message,
      }).catch((error) => {
        console.error({
          event: "discord-automation-enqueue-failed",
          automationRunId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await finishAutomationRun(run.id, { outcome: "notified", matched: true, title: answer.title, output: answer.message, conversationId, nextRunAt, pause: automation.kind === "live_check" });
  } catch (error) {
    await finishAutomationRun(run.id, {
      outcome: "failed", error: error instanceof Error ? error.message.slice(0, 2000) : "Automation execution failed.",
      nextRunAt, pause: false,
    });
  }
}
