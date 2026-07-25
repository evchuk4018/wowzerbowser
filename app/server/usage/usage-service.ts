import "server-only";

import type {
  UsageBucket,
  UsageModelSummary,
  UsageRange,
  UsageRecord,
  UsageReport,
  UsageTotals,
} from "../../../lib/usage-protocol";
import { addLocalDays, addLocalMonths, localBucketKey, localLabel, startOfLocalDay, startOfLocalMonth, usageWindow } from "./usage-time";
import { flushUsageOutbox, listUsagePricing, listUsageRecords } from "./usage-store";

function emptyTotals(): UsageTotals {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedRequestCount: 0,
    unpricedRequestCount: 0,
  };
}

function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function addRecord(target: UsageTotals | UsageModelSummary, record: UsageRecord): void {
  target.requestCount += 1;
  target.promptTokens += record.promptTokens;
  target.completionTokens += record.completionTokens;
  target.totalTokens += record.totalTokens;
  target.costUsd += record.costUsd ?? 0;
  if (record.source === "estimated") target.estimatedRequestCount += 1;
  if (record.costUsd === null) target.unpricedRequestCount += 1;
}

function modelSummary(record: UsageRecord): UsageModelSummary {
  const summary: UsageModelSummary = {
    provider: record.provider,
    model: record.model,
    label: record.pricing?.label ?? record.model,
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedRequestCount: 0,
    unpricedRequestCount: 0,
  };
  addRecord(summary, record);
  return summary;
}

function mergeModel(target: Map<string, UsageModelSummary>, record: UsageRecord): void {
  const key = modelKey(record.provider, record.model);
  const existing = target.get(key);
  if (existing) {
    addRecord(existing, record);
    return;
  }
  target.set(key, modelSummary(record));
}

function bucketBounds(key: string, range: UsageRange, timeZone: string): { start: Date; end: Date } {
  if (range === "day") {
    const [date, hourWithOffset] = key.split("T");
    const hourText = hourWithOffset.slice(0, 5);
    const offset = hourWithOffset.slice(5);
    const [year, month, day] = date.split("-").map(Number);
    const hour = Number(hourText.slice(0, 2));
    const start = offset
      ? new Date(`${date}T${hourText}:00${offset}`)
      : awaitableLocalDateToUtc(year, month, day, timeZone, hour);
    return { start, end: new Date(start.getTime() + 60 * 60_000) };
  }
  if (range === "all") {
    const [year, month] = key.split("-").map(Number);
    const start = awaitableLocalDateToUtc(year, month, 1, timeZone);
    return { start, end: addLocalMonths(start, 1, timeZone) };
  }
  const [year, month, day] = key.split("-").map(Number);
  const start = awaitableLocalDateToUtc(year, month, day, timeZone);
  return { start, end: addLocalDays(start, 1, timeZone) };
}

// Kept as a named wrapper so date-boundary logic remains easy to test and
// does not leak implementation details into the aggregation loop.
function awaitableLocalDateToUtc(year: number, month: number, day: number, timeZone: string, hour = 0): Date {
  const approximate = new Date(Date.UTC(year, month - 1, day, hour));
  const offsetParts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(approximate)
    .find(({ type }) => type === "timeZoneName")?.value ?? "GMT";
  const match = offsetParts.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) return approximate;
  const offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
  return new Date(approximate.getTime() - offset * 60_000);
}

function makeBucket(key: string, range: UsageRange, timeZone: string): UsageBucket {
  const bounds = bucketBounds(key, range, timeZone);
  return {
    key,
    label: localLabel(key, range),
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString(),
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedRequestCount: 0,
    unpricedRequestCount: 0,
    models: [],
  };
}

function bucketKeys(range: UsageRange, now: Date, timeZone: string, records: UsageRecord[]): string[] {
  const keys: string[] = [];
  if (range === "day") {
    const start = startOfLocalDay(now, timeZone);
    const end = addLocalDays(start, 1, timeZone);
    for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 60 * 60_000)) {
      keys.push(localBucketKey(cursor, range, timeZone));
    }
    return keys;
  }
  if (range === "week" || range === "month") {
    const count = range === "week" ? 7 : 30;
    const windowEnd = usageWindow(range, now, timeZone).end;
    for (let index = count - 1; index >= 0; index -= 1) keys.push(localBucketKey(addLocalDays(windowEnd, -index - 1, timeZone), range, timeZone));
    return keys;
  }
  const first = records[0] ? startOfLocalMonth(new Date(records[0].recordedAt), timeZone) : startOfLocalMonth(now, timeZone);
  const end = startOfLocalMonth(now, timeZone);
  let cursor = first;
  while (cursor <= end) {
    keys.push(localBucketKey(cursor, range, timeZone));
    cursor = addLocalMonths(cursor, 1, timeZone);
  }
  return keys;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export function aggregateUsageRecords(
  records: UsageRecord[],
  range: UsageRange,
  timeZone: string,
  now: Date,
): Pick<UsageReport, "buckets" | "totals" | "models"> {
  const keys = bucketKeys(range, now, timeZone, records);
  const buckets = new Map(keys.map((key) => [key, makeBucket(key, range, timeZone)]));
  const models = new Map<string, UsageModelSummary>();
  const totals = emptyTotals();

  records.forEach((record) => {
    addRecord(totals, record);
    mergeModel(models, record);
    const bucket = buckets.get(localBucketKey(new Date(record.recordedAt), range, timeZone));
    if (!bucket) return;
    addRecord(bucket, record);
    const bucketModels = new Map(bucket.models.map((model) => [modelKey(model.provider, model.model), model]));
    mergeModel(bucketModels, record);
    bucket.models = [...bucketModels.values()];
  });

  return {
    buckets: [...buckets.values()].map((bucket) => ({
      ...bucket,
      costUsd: roundMoney(bucket.costUsd),
      models: bucket.models.sort((left, right) => right.costUsd - left.costUsd),
    })),
    totals: { ...totals, costUsd: roundMoney(totals.costUsd) },
    models: [...models.values()].sort((left, right) => right.costUsd - left.costUsd),
  };
}

export async function getUsageReport(ownerId: string, range: UsageRange, timeZone: string): Promise<UsageReport> {
  const now = new Date();
  const window = usageWindow(range, now, timeZone);
  await flushUsageOutbox(ownerId).catch(() => undefined);
  const [records, pricing] = await Promise.all([
    listUsageRecords(ownerId, window.start && window.end ? { start: window.start.toISOString(), end: window.end.toISOString() } : undefined),
    listUsagePricing(),
  ]);
  return {
    range,
    timeZone,
    generatedAt: now.toISOString(),
    ...aggregateUsageRecords(records, range, timeZone, now),
    pricing,
  };
}
