import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseAutomationMutation } from "../lib/automation-protocol.ts";
import { nextAutomationRun } from "../app/server/automations/automation-schedule.ts";
import { messageUnlocksAutomationTools } from "../app/server/agent/automation-tool-manifest.ts";

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

test("explicit automation requests expose tools while the matching skill remains available", async () => {
  const [service, skill, settings] = await Promise.all([source("app/chat/chat-server-service.ts"), source("app/server/skills/builtin-skills.ts"), source("app/settings/settings-modal.tsx")]);
  assert.match(service, /automationToolsUnlocked \? AUTOMATION_TOOL_DEFINITIONS : \[\]/);
  assert.match(service, /automationToolsUnlocked = automationKeywordUnlock/);
  assert.match(service, /message\.role === "user" && messageUnlocksAutomationTools\(message\.content\)/);
  assert.match(service, /builtinKey === AUTOMATION_SKILL_KEY/);
  assert.match(skill, /key: "manage-automations"/);
  assert.match(skill, /Use create_automation to create the requested schedule/);
  assert.match(settings, /id: "automations", label: "Automations"/);
  assert.doesNotMatch(settings, /id: "storage"/);
});

test("automation intent detection covers recurring reports without matching ordinary news requests", () => {
  assert.equal(messageUnlocksAutomationTools("Create an automation that runs every day at 12:30"), true);
  assert.equal(messageUnlocksAutomationTools("Schedule a weekly project rundown"), true);
  assert.equal(messageUnlocksAutomationTools("Give me today's news"), false);
});

test("live checks suppress false results and pause after a match", async () => {
  const runner = await source("app/server/automations/automation-runner.ts");
  assert.match(runner, /outcome: "no_match"/);
  assert.match(runner, /pause: automation\.kind === "live_check"/);
  assert.match(runner, /chatAutomationDelivery\.deliver/);
  assert.match(runner, /queueDiscordAutomationDelivery/);
  assert.match(
    runner,
    /if \(!matched\) \{[\s\S]*?outcome: "no_match"[\s\S]*?return;[\s\S]*?\}[\s\S]*?queueDiscordAutomationDelivery/,
  );
});

test("Discord automation delivery is durable, leased, and idempotent per run", async () => {
  const [migration, repository] = await Promise.all([
    source("supabase/migrations/20260730160000_discord_automation_notifications.sql"),
    source("app/server/discord/discord-automation-repository.ts"),
  ]);
  assert.match(migration, /unique \(owner_id, automation_run_id\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at/);
  assert.match(migration, /enable row level security/);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(repository, /ignoreDuplicates: true/);
});
