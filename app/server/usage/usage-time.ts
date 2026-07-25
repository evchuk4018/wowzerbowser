import type { UsageRange } from "../../../lib/usage-protocol";

type LocalParts = { year: number; month: number; day: number; hour: number };

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  partsFormatterCache.set(timeZone, created);
  return created;
}

export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    throw new Error("timeZone must be a valid IANA timezone.");
  }
}

export function localParts(value: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(value).map(({ type, value: part }) => [type, Number(part)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
  };
}

function offsetText(value: Date, timeZone: string): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(value).find(({ type }) => type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) return "+00:00";
  return `${match[1] === "-" ? "-" : "+"}${match[2]}:${match[3]}`;
}

function offsetMinutes(value: Date, timeZone: string): number {
  const offset = offsetText(value, timeZone);
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function localDateToUtc(year: number, month: number, day: number, timeZone: string, hour = 0): Date {
  const approximate = new Date(Date.UTC(year, month - 1, day, hour));
  return new Date(approximate.getTime() - offsetMinutes(approximate, timeZone) * 60_000);
}

export function addLocalDays(value: Date, days: number, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return localDateToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
}

export function addLocalMonths(value: Date, months: number, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  const next = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  return localDateToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, timeZone);
}

export function startOfLocalDay(value: Date, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  return localDateToUtc(parts.year, parts.month, parts.day, timeZone);
}

export function startOfLocalMonth(value: Date, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  return localDateToUtc(parts.year, parts.month, 1, timeZone);
}

export function usageWindow(range: UsageRange, now: Date, timeZone: string): { start?: Date; end: Date } {
  const end = addLocalDays(startOfLocalDay(now, timeZone), 1, timeZone);
  if (range === "day") return { start: startOfLocalDay(now, timeZone), end };
  if (range === "week") return { start: addLocalDays(end, -7, timeZone), end };
  if (range === "month") return { start: addLocalDays(end, -30, timeZone), end };
  return { end };
}

export function localBucketKey(value: Date, range: UsageRange, timeZone: string): string {
  const parts = localParts(value, timeZone);
  const date = `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  if (range === "day") return `${date}T${parts.hour.toString().padStart(2, "0")}:00${offsetText(value, timeZone)}`;
  if (range === "all") return date.slice(0, 7);
  return date;
}

export function localLabel(key: string, range: UsageRange): string {
  if (range === "day") return key.slice(11, 16);
  if (range === "all") return key;
  return key.slice(5);
}
