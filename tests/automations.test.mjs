import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseAutomationMutation } from "../lib/automation-protocol.ts";
import { nextAutomationRun } from "../app/server/automations/automation-schedule.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("automation mutations enforce timezone and the 15 minute minimum", () => {
  assert.throws(() => parseAutomationMutation({ name: "RAM", kind: "live_check", instructions: "Notify below $80", schedule: { kind: "interval", everyMinutes: 14 }, timeZone: "America/New_York" }), /15/);
  assert.equal(parseAutomationMutation({ name: "News", kind: "report", instructions: "Give me a news report", schedule: { kind: "daily", localTime: "09:00" }, timeZone: "America/New_York" }).timeZone, "America/New_York");
});

test("interval and timezone schedules calculate future UTC occurrences", () => {
  assert.equal(nextAutomationRun({ kind: "interval", everyMinutes: 15 }, "Etc/UTC", new Date("2026-07-29T12:00:00Z")).toISOString(), "2026-07-29T12:15:00.000Z");
  assert.equal(nextAutomationRun({ kind: "daily", localTime: "09:00" }, "America/New_York", new Date("2026-07-29T12:00:00Z")).toISOString(), "2026-07-29T13:00:00.000Z");
  assert.equal(nextAutomationRun({ kind: "weekdays", localTime: "09:00" }, "America/New_York", new Date("2026-07-31T14:00:00Z")).toISOString(), "2026-08-03T13:00:00.000Z");
});

test("persistence and dispatcher are owner scoped and leased", async () => {
  const [migration, repository, route] = await Promise.all([source("supabase/migrations/20260730100000_recurring_automations.sql"), source("app/server/automations/automation-repository.ts"), source("app/api/internal/automations/dispatch/route.ts")]);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at/);
  assert.match(repository, /eq\("owner_id", ownerId\)/);
  assert.match(route, /AUTOMATION_DISPATCH_SECRET/);
});

test("tool schemas unlock only after the matching built-in skill is read", async () => {
  const [service, skill, settings] = await Promise.all([source("app/chat/chat-server-service.ts"), source("app/server/skills/builtin-skills.ts"), source("app/settings/settings-modal.tsx")]);
  assert.match(service, /automationToolsUnlocked \? AUTOMATION_TOOL_DEFINITIONS : \[\]/);
  assert.match(service, /builtinKey === AUTOMATION_SKILL_KEY/);
  assert.match(skill, /key: "manage-automations"/);
  assert.match(settings, /id: "automations", label: "Automations"/);
  assert.doesNotMatch(settings, /id: "storage"/);
});

test("live checks suppress false results and pause after a match", async () => {
  const runner = await source("app/server/automations/automation-runner.ts");
  assert.match(runner, /outcome: "no_match"/);
  assert.match(runner, /pause: automation\.kind === "live_check"/);
  assert.match(runner, /chatAutomationDelivery\.deliver/);
});
