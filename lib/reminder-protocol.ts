import {
  isValidTimeZone,
  parseAutomationDateTime,
  type Automation,
  type AutomationStatus,
} from "./automation-protocol";

export type ReminderStatus = Extract<AutomationStatus, "active" | "paused" | "completed" | "cancelled">;

export type Reminder = Omit<Automation, "name" | "instructions" | "kind" | "schedule"> & {
  kind: "reminder";
  title: string;
  message: string;
  at: string;
};

export type ReminderMutation = {
  title: string;
  message: string;
  at: string;
  timeZone: string;
  status?: Extract<ReminderStatus, "active" | "paused">;
};

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be 1 to ${maximum} characters.`);
  }
  return value.trim();
}

/** Parse the model/API reminder shape without performing persistence. */
export function parseReminderMutation(value: unknown, partial = false): Partial<ReminderMutation> {
  if (!value || typeof value !== "object") throw new Error("Invalid reminder.");
  const item = value as Record<string, unknown>;
  const result: Partial<ReminderMutation> = {};
  const title = item.title ?? item.name;
  const message = item.message ?? item.instructions;
  const schedule = item.schedule && typeof item.schedule === "object" ? item.schedule as Record<string, unknown> : null;
  const at = item.at ?? item.localDateTime ?? schedule?.at ?? schedule?.localDateTime;

  if (!partial || "title" in item || "name" in item) result.title = requiredText(title, "Title", 100);
  if (!partial || "message" in item || "instructions" in item) result.message = requiredText(message, "Message", 12_000);
  if (!partial || "at" in item || "localDateTime" in item || "schedule" in item) result.at = parseAutomationDateTime(at);
  if (!partial || "timeZone" in item) {
    if (typeof item.timeZone !== "string" || !isValidTimeZone(item.timeZone.trim())) throw new Error("A valid IANA timeZone is required.");
    result.timeZone = item.timeZone.trim();
  }
  if ("status" in item) {
    if (item.status !== "active" && item.status !== "paused") throw new Error("Reminder status must be active or paused.");
    result.status = item.status;
  }
  return result;
}

export function reminderFromAutomation(automation: Automation | null): Reminder | null {
  if (!automation) return null;
  if (automation.kind !== "reminder" || automation.schedule.kind !== "once") return null;
  return {
    id: automation.id,
    kind: "reminder",
    title: automation.name,
    message: automation.instructions,
    at: automation.schedule.at,
    timeZone: automation.timeZone,
    status: automation.status,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    lastOutcome: automation.lastOutcome,
    lastError: automation.lastError,
    consecutiveFailures: automation.consecutiveFailures,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}
