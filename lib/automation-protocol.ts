import { isChatModelRef, type ChatModelRef } from "./chat-protocol";

export const AUTOMATION_MIN_INTERVAL_MINUTES = 15;
export const DEFAULT_AUTOMATION_MODEL: ChatModelRef = {
  provider: "openrouter",
  model: "qwen/qwen3.7-flash",
};

export type AutomationKind = "report" | "live_check";
export type AutomationStatus = "active" | "paused";
export type AutomationSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; localTime: string }
  | { kind: "weekdays"; localTime: string }
  | { kind: "weekly"; localTime: string; weekday: number };

export type Automation = {
  id: string;
  name: string;
  kind: AutomationKind;
  instructions: string;
  schedule: AutomationSchedule;
  timeZone: string;
  status: AutomationStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: "notified" | "no_match" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomationMutation = {
  name: string;
  kind: AutomationKind;
  instructions: string;
  schedule: AutomationSchedule;
  timeZone: string;
  status?: AutomationStatus;
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function parseAutomationSchedule(value: unknown): AutomationSchedule {
  if (!value || typeof value !== "object") throw new Error("schedule is required.");
  const item = value as Record<string, unknown>;
  if (item.kind === "interval") {
    if (!Number.isInteger(item.everyMinutes) || Number(item.everyMinutes) < AUTOMATION_MIN_INTERVAL_MINUTES || Number(item.everyMinutes) > 43_200) {
      throw new Error(`Interval must be between ${AUTOMATION_MIN_INTERVAL_MINUTES} and 43200 minutes.`);
    }
    return { kind: "interval", everyMinutes: Number(item.everyMinutes) };
  }
  if (item.kind === "daily" || item.kind === "weekdays") {
    if (typeof item.localTime !== "string" || !TIME.test(item.localTime)) throw new Error("localTime must use HH:mm.");
    return { kind: item.kind, localTime: item.localTime };
  }
  if (item.kind === "weekly") {
    if (typeof item.localTime !== "string" || !TIME.test(item.localTime)) throw new Error("localTime must use HH:mm.");
    if (!Number.isInteger(item.weekday) || Number(item.weekday) < 0 || Number(item.weekday) > 6) throw new Error("weekday must be 0 through 6.");
    return { kind: "weekly", localTime: item.localTime, weekday: Number(item.weekday) };
  }
  throw new Error("Unsupported schedule kind.");
}

export function parseAutomationMutation(value: unknown, partial = false): Partial<AutomationMutation> {
  if (!value || typeof value !== "object") throw new Error("Invalid automation.");
  const item = value as Record<string, unknown>;
  const result: Partial<AutomationMutation> = {};
  if (!partial || "name" in item) {
    if (typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > 100) throw new Error("Name must be 1 to 100 characters.");
    result.name = item.name.trim();
  }
  if (!partial || "kind" in item) {
    if (item.kind !== "report" && item.kind !== "live_check") throw new Error("kind must be report or live_check.");
    result.kind = item.kind;
  }
  if (!partial || "instructions" in item) {
    if (typeof item.instructions !== "string" || !item.instructions.trim() || item.instructions.trim().length > 12_000) throw new Error("Instructions must be 1 to 12000 characters.");
    result.instructions = item.instructions.trim();
  }
  if (!partial || "schedule" in item) result.schedule = parseAutomationSchedule(item.schedule);
  if (!partial || "timeZone" in item) {
    if (typeof item.timeZone !== "string" || !isValidTimeZone(item.timeZone)) throw new Error("A valid IANA timeZone is required.");
    result.timeZone = item.timeZone;
  }
  if ("status" in item) {
    if (item.status !== "active" && item.status !== "paused") throw new Error("status must be active or paused.");
    result.status = item.status;
  }
  return result;
}

export function parseAutomationModel(value: unknown): ChatModelRef | null {
  return isChatModelRef(value) ? value : null;
}
