import "server-only";

import type { DeepResearchPlan } from "../../../lib/chat-protocol";
import type { ChatSource } from "../../../lib/chat-citations";
import { completeOpenRouterQwenText } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { runSubagents, type SubagentResult, type SubagentStatus, type SubagentTask, type SubagentUpdate } from "../agent/subagent-coordinator";
import {
  performDeepResearch,
  recordResearchModelUsage,
  ResearchTraceCoordinator,
  type ResearchProgressUpdate,
  type ResearchTrace,
} from "./deep-research-service";

export type Finding = { taskId: string; title: string; claims: unknown[]; sources: ChatSource[]; warnings: string[] };

export type ResearchOrchestratorStatus = "running" | "completed" | "failed";
export type ResearchOrchestratorUpdate = {
  status: ResearchOrchestratorStatus;
  reasoningDelta?: string;
  summary?: string;
  summaryRevision?: number;
  trace?: ResearchTrace[];
};
export type ResearchSubagentUpdate = {
  task: SubagentTask;
  status: SubagentStatus;
  summary?: string;
  summaryRevision?: number;
  trace?: ResearchTrace[];
};
export type ResearchOrchestratorCallback = (update: ResearchOrchestratorUpdate) => Promise<void> | void;
export type ResearchSubagentCallback = (update: ResearchSubagentUpdate) => Promise<void> | void;

async function emitOrchestrator(callback: ResearchOrchestratorCallback | undefined, update: ResearchOrchestratorUpdate): Promise<void> {
  try {
    await callback?.(update);
  } catch {
    // Presentation callbacks are best effort.
  }
}

async function emitSubagent(callback: ResearchSubagentCallback | undefined, update: ResearchSubagentUpdate): Promise<void> {
  try {
    await callback?.(update);
  } catch {
    // Presentation callbacks are best effort.
  }
}

export async function orchestrateDeepResearch(input: {
  ownerId: string;
  conversationId: string;
  jobId: string;
  request: string;
  plan: DeepResearchPlan;
  signal?: AbortSignal;
  onOrchestratorUpdate?: ResearchOrchestratorCallback;
  onSubagentUpdate?: ResearchSubagentCallback;
}): Promise<{ report: string; sources: ChatSource[]; findings: Finding[] }> {
  const tasks = input.plan.items.map((item) => ({ id: item.id, title: item.title, prompt: `${item.question}\nFocus: ${item.focus}` }));
  const orchestratorTrace = new ResearchTraceCoordinator({
    actorId: input.jobId,
    signal: input.signal,
    onUpdate: async (update: ResearchProgressUpdate) => emitOrchestrator(input.onOrchestratorUpdate, { status: "running", ...update }),
    onReasoningDelta: async (reasoningDelta) => emitOrchestrator(input.onOrchestratorUpdate, { status: "running", reasoningDelta }),
    onSummaryUsage: async (usage) => recordResearchModelUsage({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      jobId: input.jobId,
      requestKind: "reasoning_summary",
      round: 2_000_000 + usage.phase * 100_000 + usage.revision,
      answer: usage,
    }),
  });

  await emitOrchestrator(input.onOrchestratorUpdate, { status: "running", summary: "Preparing research" });
  await emitOrchestrator(input.onOrchestratorUpdate, { status: "running", summary: "Researching approved topics" });

  try {
    const results = await runSubagents<Finding>({
      tasks,
      signal: input.signal,
      concurrency: 3,
      onUpdate: async (update: SubagentUpdate) => emitSubagent(input.onSubagentUpdate, update),
      worker: async (task, signal) => {
        const run = await performDeepResearch({
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          jobId: `${input.jobId}-${task.id}`,
          request: task.prompt,
          signal,
          onUpdate: async (update) => emitSubagent(input.onSubagentUpdate, {
            task,
            status: "running",
            ...update,
          }),
        });
        return { taskId: task.id, title: task.title, claims: run.claims, sources: run.sources, warnings: run.warnings };
      },
    });
    const findings = results.flatMap((result: SubagentResult<Finding>) => result.value ? [result.value] : []);
    const sources = [...new Map(findings.flatMap((finding) => finding.sources).map((source) => [source.id, source])).values()];
    const evidence = findings.map((finding) => [
      `## ${finding.title}`,
      JSON.stringify(finding.claims).slice(0, 14_000),
      finding.sources.slice(0, 8).map((source) => `- [${source.title}](${source.url}) — ${source.snippet}`).join("\n"),
      finding.warnings.length ? `Warnings: ${finding.warnings.join("; ")}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");

    await orchestratorTrace.update("synthesis", "started");
    const answer = await completeOpenRouterQwenText(
      `<question>\n${input.request}\n</question>\n<research>\n${evidence.slice(0, 50_000)}\n</research>`,
      {
        systemPrompt: "You are the final deep-research editor. Produce a clear report answering the question, organize it by the approved topics, distinguish evidence from uncertainty, and preserve relevant Markdown source links. Do not invent facts or sources.",
        signal: input.signal,
        maxTokens: 5000,
        stream: true,
        reasoningEffort: "low",
        onReasoningDelta: (delta) => orchestratorTrace.appendReasoning(delta),
      },
    );
    await recordResearchModelUsage({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      jobId: input.jobId,
      requestKind: "deep_research",
      round: 1,
      answer,
    });
    await orchestratorTrace.update("synthesis", "completed", "completed");
    await orchestratorTrace.finish();
    await emitOrchestrator(input.onOrchestratorUpdate, { status: "completed", summary: "Research synthesis complete" });
    return { report: answer.content, sources, findings };
  } catch (error) {
    await orchestratorTrace.update("synthesis", "failed", "failed");
    await orchestratorTrace.finish();
    await emitOrchestrator(input.onOrchestratorUpdate, {
      status: "failed",
      summary: input.signal?.aborted ? "Research cancelled" : "Research failed",
    });
    throw error;
  }
}
