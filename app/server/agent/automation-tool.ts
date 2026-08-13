import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { createAutomation, deleteAutomation, getAutomation, listAutomations, updateAutomation } from "../automations/automation-service";
import { cancelReminder, createReminder, getReminder, listReminders, updateReminder } from "../reminders/reminder-service";
import { AUTOMATION_TOOL_NAMES, REMINDER_TOOL_NAMES } from "./automation-tool-manifest";

const fail = (call: ChatToolCall, stderr: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr });
export async function executeAutomationTool(call: ChatToolCall, ownerId: string, options: { defaultTimeZone?: string } = {}): Promise<ChatToolResult> {
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
    } else if (call.name === REMINDER_TOOL_NAMES.list) output = await listReminders(ownerId);
    else if (call.name === REMINDER_TOOL_NAMES.get) output = await getReminder(ownerId, String(input.reminderId ?? ""));
    else if (call.name === REMINDER_TOOL_NAMES.create) output = await createReminder(ownerId, input, options.defaultTimeZone);
    else if (call.name === REMINDER_TOOL_NAMES.update) {
      const { reminderId, ...patch } = input;
      output = await updateReminder(ownerId, String(reminderId ?? ""), patch);
    } else if (call.name === REMINDER_TOOL_NAMES.cancel) {
      output = await cancelReminder(ownerId, String(input.reminderId ?? ""));
    } else return fail(call, `Unknown automation tool: ${call.name}`);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(output), stderr: "" };
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : "Automation operation failed.");
  }
}
