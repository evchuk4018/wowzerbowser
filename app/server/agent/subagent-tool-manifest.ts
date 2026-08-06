import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";

export const RUN_SUBAGENT_TOOL_NAME = "run_subagent";

export const RUN_SUBAGENT_TOOL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: RUN_SUBAGENT_TOOL_NAME,
    description: "Delegate one independent task to another copy of the agent. The delegated agent can use the normal chat, web, workspace, document, and connected-service tools. Prefer parallel search, codebase inspection, source comparison, or independent review; do not use it for simple or sequential work.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 12_000,
          description: "The independent task for the delegated agent.",
        },
        context: {
          type: "string",
          maxLength: 16_000,
          description: "Optional focused context or constraints the delegated agent should use.",
        },
      },
    },
  },
};
