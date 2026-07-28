import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateUsageCost, estimateUsageFromText } from "../lib/usage-pricing.ts";
import { DEFAULT_DEEPSEEK_USAGE_PRICING } from "../app/providers/deepseek/deepseek-pricing.ts";
import { localBucketKey, localParts, usageWindow } from "../app/server/usage/usage-time.ts";
import { aggregateUsageRecords } from "../app/server/usage/usage-service.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("calculates separate input, cached-input, and output costs", () => {
  const pricing = DEFAULT_DEEPSEEK_USAGE_PRICING[0];
  const cost = calculateUsageCost({ promptTokens: 1_000_000, cachedPromptTokens: 200_000, completionTokens: 100_000 }, pricing);
  assert.equal(cost, 0.14 * 0.8 + 0.0028 * 0.2 + 0.28 * 0.1);
});

test("estimates missing provider usage and keeps the estimate bounded", () => {
  const estimate = estimateUsageFromText("a".repeat(9), "b".repeat(5));
  assert.deepEqual(estimate, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(calculateUsageCost(estimate, DEFAULT_DEEPSEEK_USAGE_PRICING[1]), (3 * 0.435 + 2 * 0.87) / 1_000_000);
});

test("local usage windows and buckets use the requested timezone", () => {
  const now = new Date("2026-07-24T02:30:00.000Z");
  const parts = localParts(now, "America/New_York");
  assert.deepEqual(parts, { year: 2026, month: 7, day: 23, hour: 22 });
  assert.equal(localBucketKey(now, "day", "America/New_York"), "2026-07-23T22:00-04:00");
  const week = usageWindow("week", now, "America/New_York");
  assert.equal(week.end.toISOString(), "2026-07-24T04:00:00.000Z");
  assert.equal(week.start.toISOString(), "2026-07-17T04:00:00.000Z");
});

test("aggregates report bars, totals, model breakdowns, and estimates", () => {
  const pricing = DEFAULT_DEEPSEEK_USAGE_PRICING[0];
  const report = aggregateUsageRecords([
    {
      provider: "deepseek",
      model: pricing.model,
      requestKind: "chat",
      requestId: "job-1",
      round: 1,
      recordedAt: "2026-07-23T23:30:00.000Z",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.00001,
      source: "exact",
      pricing,
    },
    {
      provider: "deepseek",
      model: pricing.model,
      requestKind: "chat",
      requestId: "job-2",
      round: 1,
      recordedAt: "2026-07-24T02:00:00.000Z",
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      source: "estimated",
      pricing: null,
    },
  ], "week", "America/New_York", new Date("2026-07-24T02:30:00.000Z"));
  assert.equal(report.totals.requestCount, 2);
  assert.equal(report.totals.totalTokens, 45);
  assert.equal(report.totals.estimatedRequestCount, 1);
  assert.equal(report.totals.unpricedRequestCount, 1);
  assert.equal(report.models[0].requestCount, 2);
  assert.equal(report.buckets.find(({ key }) => key === "2026-07-23")?.requestCount, 2);
});

test("day charts preserve the real number of daylight-saving hours", () => {
  const spring = aggregateUsageRecords([], "day", "America/New_York", new Date("2026-03-08T17:00:00.000Z"));
  const fall = aggregateUsageRecords([], "day", "America/New_York", new Date("2026-11-01T17:00:00.000Z"));
  assert.equal(spring.buckets.length, 23);
  assert.equal(fall.buckets.length, 25);
});

test("usage persistence and API keep provider data server-side and owner-scoped", async () => {
  const [migration, store, route, runner, title, service] = await Promise.all([
    source("supabase/migrations/20260724030000_usage_tracking.sql"),
    source("app/server/usage/usage-store.ts"),
    source("app/api/chat/usage/route.ts"),
    source("app/server/chat/chat-job-runner.ts"),
    source("app/providers/deepseek/deepseek-title.ts"),
    source("app/chat/chat-usage-service.ts"),
  ]);
  assert.match(migration, /chat_model_pricing/);
  assert.match(migration, /chat_usage_records/);
  assert.match(migration, /chat_usage_outbox/);
  assert.match(migration, /unique \(owner_id, provider, request_kind, request_id, round\)/);
  assert.match(migration, /alter table public\.chat_usage_records enable row level security/);
  assert.match(store, /eq\("owner_id", ownerId\)/);
  assert.match(store, /usage_source/);
  assert.match(store, /flushUsageOutbox/);
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /assertTimeZone/);
  assert.match(runner, /requestKind: "chat"/);
  assert.match(runner, /provider,/);
  assert.match(runner, /exactCostUsd/);
  assert.match(title, /persistUsage/);
  assert.match(title, /estimateUsageFromText/);
  assert.match(service, /\/api\/chat\/usage/);
});
