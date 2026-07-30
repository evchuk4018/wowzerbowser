import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const SEARCH_CURRENT_CHAT_TOOL_NAME = "search_current_chat";

export const SEARCH_CURRENT_CHAT_TOOL_DEFINITION: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: SEARCH_CURRENT_CHAT_TOOL_NAME,
    description: "Search relevant visible messages and compact tool facts omitted from the current focused-context prompt.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 400 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
  },
};

export const CURRENT_CHAT_CONTEXT_TOOL_INSTRUCTIONS = [
  "<focused_context>",
  "Some older turns were omitted to keep the prompt focused.",
  "Use search_current_chat when an omitted decision, requirement, prior answer, artifact, or tool fact may materially affect the response.",
  "Search results contain visible conversation content and compact tool facts only; historical private reasoning is intentionally unavailable.",
  "</focused_context>",
].join("\n");
