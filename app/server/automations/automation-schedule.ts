import type { AutomationSchedule } from "../../../lib/automation-protocol";

const localParts = (date: Date, timeZone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
) as Record<string, number>;

function localDateToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    guess += desired - represented;
  }
  return new Date(guess);
}

function reminderAtToUtc(at: string, timeZone: string): Date {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(at)) return new Date(at);
  const [date, time] = at.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return localDateToUtc(year, month, day, hour, minute, timeZone);
}

export function reminderTimeInUtc(at: string, timeZone: string): Date {
  const result = reminderAtToUtc(at, timeZone);
  if (!Number.isFinite(result.getTime())) throw new Error("Could not calculate the reminder time.");
  return result;
}

export function nextAutomationRun(schedule: AutomationSchedule, timeZone: string, after = new Date()): Date {
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.everyMinutes * 60_000);
  if (schedule.kind === "once") {
    const candidate = reminderTimeInUtc(schedule.at, timeZone);
    if (candidate.getTime() <= after.getTime()) throw new Error("Reminder time must be in the future.");
    return candidate;
  }
  const current = localParts(after, timeZone);
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const localDay = new Date(Date.UTC(current.year, current.month - 1, current.day + offset));
    const weekday = localDay.getUTCDay();
    if (schedule.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.kind === "weekly" && weekday !== schedule.weekday) continue;
    const candidate = localDateToUtc(localDay.getUTCFullYear(), localDay.getUTCMonth() + 1, localDay.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("Could not calculate the next automation run.");
}

/**
 * Return the next occurrence after an already-claimed occurrence. During a
 * long outage an interval may have many missed occurrences; the scheduler
 * executes the claimed one once and skips directly to the first future slot.
 */
export function nextFutureAutomationRun(
  schedule: AutomationSchedule,
  timeZone: string,
  claimedFor: Date,
  now = new Date(),
): Date {
  if (schedule.kind === "once") throw new Error("A one-off reminder has no next occurrence.");
  if (schedule.kind === "interval") {
    const intervalMs = schedule.everyMinutes * 60_000;
    const elapsed = now.getTime() - claimedFor.getTime();
    const intervals = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
    return new Date(claimedFor.getTime() + intervals * intervalMs);
  }

  let candidate = nextAutomationRun(schedule, timeZone, claimedFor);
  // Calendar schedules advance at most seven days per iteration. The bound
  // also prevents malformed persisted schedules from making a worker spin.
  for (let attempt = 0; attempt < 4_000 && candidate.getTime() <= now.getTime(); attempt += 1) {
    candidate = nextAutomationRun(schedule, timeZone, candidate);
  }
  if (candidate.getTime() <= now.getTime()) throw new Error("Could not advance the automation to a future occurrence.");
  return candidate;
}
