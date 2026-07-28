import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const PHASE_BREAK_TOOL_NAME = "phase_break";

export const PHASE_BREAK_TOOL_DEFINITION: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: PHASE_BREAK_TOOL_NAME,
    description: "Begin a meaningfully different stage of the current task. Optionally provide a brief progress update for the user. Do not call this merely because another tool call is needed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        userUpdate: {
          type: "string",
          maxLength: 320,
          description: "Optional concise user-facing progress update shown between thinking phases.",
        },
      },
    },
  },
};

export function executePhaseBreak(call: ChatToolCall, nextPhase: number): {
  update?: string;
  result: ChatToolResult;
} {
  let update: string | undefined;
  try {
    const value = JSON.parse(call.arguments || "{}") as { userUpdate?: unknown };
    if (typeof value.userUpdate === "string" && value.userUpdate.trim()) {
      update = value.userUpdate.trim().slice(0, 320);
    }
  } catch {
    // A phase break remains safe even when its optional presentation argument is malformed.
  }
  return {
    ...(update ? { update } : {}),
    result: {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: JSON.stringify({ phase: nextPhase }),
      stderr: "",
    },
  };
}
