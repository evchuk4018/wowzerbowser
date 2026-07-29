import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const SEARCH_CHATS_TOOL_NAME = "search_chats";
export const RECALL_CHATS_TOOL_NAME = "recall_chats";

export const CHAT_MEMORY_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  {
    type: "function",
    function: {
      name: SEARCH_CHATS_TOOL_NAME,
      description: "Search the user's private chats and return the same conversation summaries visible in chat search.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", maxLength: 200 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: RECALL_CHATS_TOOL_NAME,
      description: "Ask the Qwen Flash model a question about the active branch of a private chat. Search chats first to find its conversationId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["conversationId", "prompt"],
        properties: {
          conversationId: { type: "string", minLength: 1, maxLength: 200 },
          prompt: { type: "string", minLength: 1, maxLength: 2_000 },
        },
      },
    },
  },
];
