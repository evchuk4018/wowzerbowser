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

export function nextAutomationRun(schedule: AutomationSchedule, timeZone: string, after = new Date()): Date {
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.everyMinutes * 60_000);
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
