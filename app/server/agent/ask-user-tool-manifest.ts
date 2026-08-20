import "server-only";

import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";

export const ASK_USER_TOOL_NAME = "ask_user" as const;

export const ASK_USER_TOOL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: ASK_USER_TOOL_NAME,
    description: "Escalate a question to the human. Use when the homelab opencode turn or any other task needs a decision you cannot make from context. The run will pause and the user will be notified via Discord and the web UI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2000, description: "The question for the human." },
        context: { type: "string", maxLength: 4000, description: "Optional context that helps the user answer." },
        options: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } },
      },
    },
  },
};

export function availableAskUserTools(automationExecution: boolean): ModelToolDefinition[] {
  void automationExecution;
  return [ASK_USER_TOOL_DEFINITION];
}
