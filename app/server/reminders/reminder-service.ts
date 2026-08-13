import "server-only";

import {
  parseReminderMutation,
  reminderFromAutomation,
  type Reminder,
  type ReminderMutation,
} from "../../../lib/reminder-protocol";
import type { Automation } from "../../../lib/automation-protocol";
import { nextAutomationRun } from "../automations/automation-schedule";
import {
  cancelReminderRow,
  getAutomationRow,
  insertAutomationRow,
  listAutomationRows,
  updateAutomationRow,
} from "../automations/automation-repository";

export class ReminderNotFoundError extends Error {}
export class ReminderStateError extends Error {}

function requireReminder(automation: Automation | null): Reminder {
  const value = reminderFromAutomation(automation);
  if (!value) throw new ReminderNotFoundError("Reminder not found.");
  return value;
}

export async function listReminders(ownerId: string): Promise<Reminder[]> {
  return (await listAutomationRows(ownerId)).flatMap((automation) => {
    const reminder = reminderFromAutomation(automation);
    return reminder ? [reminder] : [];
  });
}

export async function getReminder(ownerId: string, id: string): Promise<Reminder | null> {
  const automation = await getAutomationRow(ownerId, id);
  return automation ? reminderFromAutomation(automation) : null;
}

export async function createReminder(ownerId: string, input: unknown, defaultTimeZone?: string): Promise<Reminder> {
  const withDefault = input && typeof input === "object" && defaultTimeZone && !("timeZone" in input)
    ? { ...(input as Record<string, unknown>), timeZone: defaultTimeZone }
    : input;
  const values = parseReminderMutation(withDefault) as ReminderMutation;
  const status = values.status ?? "active";
  const schedule = { kind: "once" as const, at: values.at };
  const nextRunAt = status === "active" ? nextAutomationRun(schedule, values.timeZone).toISOString() : null;
  const automation = await insertAutomationRow(ownerId, {
    name: values.title,
    kind: "reminder",
    instructions: values.message,
    schedule,
    timeZone: values.timeZone,
    status,
  }, nextRunAt);
  return requireReminder(automation);
}

export async function updateReminder(ownerId: string, id: string, input: unknown): Promise<Reminder> {
  const currentAutomation = await getAutomationRow(ownerId, id);
  const current = requireReminder(currentAutomation);
  if (current.status === "completed" || current.status === "cancelled") throw new ReminderStateError("Completed or cancelled reminders cannot be edited.");
  const patch = parseReminderMutation(input, true);
  const merged = { ...current, ...patch };
  const status = patch.status ?? current.status;
  const timeChanged = Boolean(patch.at || patch.timeZone || patch.status);
  const row = await updateAutomationRow(ownerId, id, {
    ...(patch.title ? { name: patch.title } : {}),
    ...(patch.message ? { instructions: patch.message } : {}),
    ...(patch.at ? { schedule: { kind: "once", at: patch.at } } : {}),
    ...(patch.timeZone ? { time_zone: patch.timeZone } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(timeChanged ? { next_run_at: status === "active" ? nextAutomationRun({ kind: "once", at: merged.at }, merged.timeZone).toISOString() : null } : {}),
  });
  return requireReminder(row);
}

export async function cancelReminder(ownerId: string, id: string): Promise<Reminder> {
  const current = await getReminder(ownerId, id);
  if (!current) throw new ReminderNotFoundError("Reminder not found.");
  if (current.status === "completed") throw new ReminderStateError("Reminder is already completed.");
  if (current.status === "cancelled") return current;
  return requireReminder(await cancelReminderRow(ownerId, id));
}
