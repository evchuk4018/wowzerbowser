import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const COMPLETE_AUTOMATION_RUN_TOOL_NAME = "complete_automation_run";
export type AutomationRunResult = { matched: boolean; title: string; message: string };

export const COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: COMPLETE_AUTOMATION_RUN_TOOL_NAME,
    description: "Finish the current background automation with its structured decision and user-facing result.",
    parameters: {
      type: "object", additionalProperties: false, required: ["matched", "title", "message"],
      properties: {
        matched: { type: "boolean" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        message: { type: "string", maxLength: 50000 },
      },
    },
  },
};

export function executeCompleteAutomationRun(call: ChatToolCall): { result: ChatToolResult; value?: AutomationRunResult } {
  try {
    const input = JSON.parse(call.arguments) as Record<string, unknown>;
    if (typeof input.matched !== "boolean" || typeof input.title !== "string" || !input.title.trim() || typeof input.message !== "string") throw new Error("matched, title, and message are required.");
    const value = { matched: input.matched, title: input.title.trim().slice(0, 160), message: input.message.trim().slice(0, 50_000) };
    return { value, result: { id: call.id, name: call.name, ok: true, stdout: JSON.stringify({ accepted: true }), stderr: "" } };
  } catch (error) {
    return { result: { id: call.id, name: call.name, ok: false, stdout: "", stderr: error instanceof Error ? error.message : "Invalid automation result." } };
  }
}
