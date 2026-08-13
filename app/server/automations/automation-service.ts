import "server-only";
import { parseAutomationMutation, type Automation, type AutomationMutation } from "../../../lib/automation-protocol";
import { nextAutomationRun } from "./automation-schedule";
import { getAutomationRow, insertAutomationRow, listAutomationRows, softDeleteAutomationRow, updateAutomationRow } from "./automation-repository";

export class AutomationNotFoundError extends Error {}

export async function listAutomations(ownerId: string): Promise<Automation[]> {
  return (await listAutomationRows(ownerId)).filter((item) => item.kind !== "reminder");
}

export async function getAutomation(ownerId: string, id: string): Promise<Automation | null> {
  const item = await getAutomationRow(ownerId, id);
  return item?.kind === "reminder" ? null : item;
}

export async function createAutomation(ownerId: string, input: unknown): Promise<Automation> {
  const values = parseAutomationMutation(input) as AutomationMutation;
  const status = values.status ?? "active";
  return insertAutomationRow(ownerId, values, status === "active" ? nextAutomationRun(values.schedule, values.timeZone).toISOString() : null);
}

export async function updateAutomation(ownerId: string, id: string, input: unknown): Promise<Automation> {
  const current = await getAutomationRow(ownerId, id);
  if (!current) throw new AutomationNotFoundError("Automation not found.");
  if (current.kind === "reminder") throw new AutomationNotFoundError("Use the reminder tools to edit a one-off reminder.");
  const patch = parseAutomationMutation(input, true);
  const merged = { ...current, ...patch };
  const status = patch.status ?? current.status;
  const scheduleChanged = Boolean(patch.schedule || patch.timeZone || patch.status);
  const row = await updateAutomationRow(ownerId, id, {
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.kind ? { kind: patch.kind } : {}),
    ...(patch.instructions ? { instructions: patch.instructions } : {}),
    ...(patch.schedule ? { schedule: patch.schedule } : {}),
    ...(patch.timeZone ? { time_zone: patch.timeZone } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(scheduleChanged ? { next_run_at: status === "active" ? nextAutomationRun(merged.schedule, merged.timeZone).toISOString() : null } : {}),
    ...(patch.status === "active" ? { consecutive_failures: 0, last_error: null } : {}),
  });
  if (!row) throw new AutomationNotFoundError("Automation not found.");
  return row;
}

export async function deleteAutomation(ownerId: string, id: string): Promise<void> {
  if (!await softDeleteAutomationRow(ownerId, id)) throw new AutomationNotFoundError("Automation not found.");
}
