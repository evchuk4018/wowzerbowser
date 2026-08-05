import "server-only";

import type { DeepResearchPlan } from "../../../lib/chat-protocol";
import type { ChatSource } from "../../../lib/chat-citations";
import { completeOpenRouterQwenText } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { runSubagents, type SubagentResult } from "../agent/subagent-coordinator";
import { performDeepResearch } from "./deep-research-service";

type Finding = { taskId: string; title: string; claims: unknown[]; sources: ChatSource[]; warnings: string[] };

export async function orchestrateDeepResearch(input: {
  ownerId: string;
  conversationId: string;
  jobId: string;
  request: string;
  plan: DeepResearchPlan;
  signal?: AbortSignal;
  onUpdate?: Parameters<typeof runSubagents<Finding>>[0]["onUpdate"];
}): Promise<{ report: string; sources: ChatSource[]; findings: Finding[] }> {
  const tasks = input.plan.items.map((item) => ({ id: item.id, title: item.title, prompt: `${item.question}\nFocus: ${item.focus}` }));
  const results = await runSubagents<Finding>({
    tasks,
    signal: input.signal,
    concurrency: 3,
    onUpdate: input.onUpdate,
    worker: async (task, signal) => {
      const run = await performDeepResearch({ ownerId: input.ownerId, conversationId: input.conversationId, jobId: `${input.jobId}-${task.id}`, request: task.prompt, signal });
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
  const answer = await completeOpenRouterQwenText(
    `<question>\n${input.request}\n</question>\n<research>\n${evidence.slice(0, 50_000)}\n</research>`,
    { systemPrompt: "You are the final deep-research editor. Produce a clear report answering the question, organize it by the approved topics, distinguish evidence from uncertainty, and preserve relevant Markdown source links. Do not invent facts or sources.", signal: input.signal, maxTokens: 5000 },
  );
  return { report: answer.content, sources, findings };
}
