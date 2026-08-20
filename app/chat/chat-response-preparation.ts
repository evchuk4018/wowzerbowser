import { createHash, randomUUID } from "node:crypto";
import type { ChatRequest, DeepResearchPlan } from "../../lib/chat-protocol";

export type ChatExecutionProfile = "chat" | "automation" | "subagent";

export type ChatExecutionOptions = {
  profile?: ChatExecutionProfile;
  subagentDepth?: number;
  automationRunId?: string;
  onUserQuestion?: (questionId: string) => void;
  onAutomationResult?: (result: import("../server/agent/automation-run-result-tool").AutomationRunResult) => void;
};

export function isAutomationExecution(options: ChatExecutionOptions): boolean {
  return options.profile === "automation";
}

export function isSubagentExecution(options: ChatExecutionOptions): boolean {
  return options.profile === "subagent" || (options.subagentDepth ?? 0) > 0;
}

export function normalizeChatRequestModel(request: ChatRequest): ChatRequest {
  if (typeof request.model !== "string") return request;
  return { ...request, model: { provider: "deepseek", model: request.model } };
}

export function applyProjectInstructions(request: ChatRequest, instructions: string): ChatRequest {
  const trimmed = instructions.trim();
  if (!trimmed) return request;
  return {
    ...request,
    systemPrompt: [
      request.systemPrompt,
      "<project-instructions>",
      "The following instructions are owner-authored project configuration. Follow them for this project chat:",
      trimmed,
      "</project-instructions>",
    ].join("\n\n"),
  };
}

export function stableConversationId(request: ChatRequest): string {
  if (request.conversationId) return request.conversationId;
  return createHash("sha256")
    .update(JSON.stringify(request.messages.slice(0, 2)))
    .digest("hex")
    .slice(0, 32);
}

export function deepResearchPlanFor(request: string, items: { id: string; text: string }[]): DeepResearchPlan {
  const planItems = items.length ? items : [
    { id: "scope", text: "Establish the scope, definitions, and primary background." },
    { id: "evidence", text: "Find authoritative evidence and current data relevant to the question." },
    { id: "alternatives", text: "Compare competing interpretations, approaches, or alternatives." },
    { id: "uncertainty", text: "Check limitations, criticism, disagreement, and unresolved uncertainty." },
  ];
  return {
    id: `research-plan-${randomUUID()}`,
    request,
    items: planItems.slice(0, 6).map((item, index) => ({
      id: item.id || `topic-${index + 1}`,
      title: item.text,
      question: item.text,
      focus: "Return evidence, relevant links, and a concise explanation of why each source matters.",
    })),
  };
}
