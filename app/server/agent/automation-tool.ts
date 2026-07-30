import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { createAutomation, deleteAutomation, getAutomation, listAutomations, updateAutomation } from "../automations/automation-service";
import { AUTOMATION_TOOL_NAMES } from "./automation-tool-manifest";

const fail = (call: ChatToolCall, stderr: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr });
export async function executeAutomationTool(call: ChatToolCall, ownerId: string): Promise<ChatToolResult> {
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    let output: unknown;
    if (call.name === AUTOMATION_TOOL_NAMES.list) output = await listAutomations(ownerId);
    else if (call.name === AUTOMATION_TOOL_NAMES.get) output = await getAutomation(ownerId, String(input.automationId ?? ""));
    else if (call.name === AUTOMATION_TOOL_NAMES.create) output = await createAutomation(ownerId, input);
    else if (call.name === AUTOMATION_TOOL_NAMES.update) {
      const { automationId, ...patch } = input;
      output = await updateAutomation(ownerId, String(automationId ?? ""), patch);
    } else if (call.name === AUTOMATION_TOOL_NAMES.delete) {
      await deleteAutomation(ownerId, String(input.automationId ?? ""));
      output = { deleted: true };
    } else return fail(call, `Unknown automation tool: ${call.name}`);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(output), stderr: "" };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : "Automation operation failed.");
  }
}
